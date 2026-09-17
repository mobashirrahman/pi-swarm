/**
 * Scheduler load harness — the Phase 5 gate evidence.
 *
 * The plan says: do NOT go distributed until a single scheduler is a
 * MEASURED bottleneck. This harness measures what one scheduler can do so
 * that decision is made on numbers, not vibes.
 *
 * It drives the real Dispatcher against a local fake provider (real HTTP,
 * real quota registry, real leases) with N concurrent agents, and reports
 * throughput + latency percentiles. No external API is touched.
 *
 * Usage: npx tsx scripts/bench-scheduler.ts [agents] [turnsPerAgent] [--leases]
 */

import { createServer, type Server } from "node:http";
import { AgentRuntime, type AgentSpec } from "../src/agent.ts";
import { AccountRegistry } from "../src/catalog.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { MemoryLeaseStore, SqliteLeaseStore } from "../src/leases.ts";
import { ToolExecutor, registerBuiltinTools } from "../src/tools.ts";
import { AgentStore } from "../src/store.ts";

const agents = Number.parseInt(process.argv[2] ?? "12", 10);
const turnsPerAgent = Number.parseInt(process.argv[3] ?? "4", 10);
const useLeases = process.argv.includes("--leases");

/** Fake provider: streams a short answer after a simulated think time. */
function startFakeProvider(latencyMs: number): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		req.on("data", () => undefined);
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream", "x-ratelimit-remaining-requests": "9999", "x-ratelimit-limit-requests": "10000" });
			setTimeout(() => {
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
			}, latencyMs);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
		});
	});
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index] ?? 0;
}

const thinkMs = Number.parseInt(process.env.BENCH_THINK_MS ?? "120", 10);
const { server, baseUrl } = await startFakeProvider(thinkMs);

const accounts = new AccountRegistry();
// Two accounts × concurrency 8: enough headroom that the SCHEDULER, not the
// cap, is what the benchmark measures.
for (const id of ["fake-a", "fake-b"]) {
	accounts.register({
		accountId: `${id}:primary`,
		providerId: id,
		credentialRef: `${id.toUpperCase()}_API_KEY`,
		enabled: true,
		maxConcurrency: 8,
		baseUrl,
	});
}

const leaseStore = useLeases ? new SqliteLeaseStore(new AgentStore(process.env.BENCH_DB ?? "/tmp/pi-swarm-bench.db").database) : undefined;
const dispatcher = new Dispatcher({
	accounts,
	leases: useLeases ? leaseStore : undefined,
	fetchModels: async () => [
		{ id: "fake-model-1", context_length: 128_000 },
		{ id: "fake-model-2", context_length: 128_000 },
	],
});
await dispatcher.loadCandidates();

const toolExecutor = new ToolExecutor();
registerBuiltinTools(toolExecutor);

function spec(agentId: string): AgentSpec {
	return {
		agentId,
		task: "benchmark turn",
		maxTurns: turnsPerAgent,
		maxWallTimeMs: 120_000,
		maxProviderAttemptsPerTurn: 3,
		capabilities: ["text"],
		qualityFloor: null,
		allowUnknownQuality: true,
	};
}

const startedAt = Date.now();
const durations: number[] = [];
let completed = 0;
let failed = 0;

await Promise.all(
	Array.from({ length: agents }, (_, index) => {
		const agentId = `bench-${index}`;
		const agentStarted = Date.now();
		const runtime = new AgentRuntime(
			spec(agentId),
			{ executeTurn: (messages, opts) => dispatcher.executeTurn(messages, opts, toolExecutor.specs()) },
			{ execute: (id, turn, call, tool, argsJson, signal) => toolExecutor.execute(id, turn, call, tool, argsJson, signal) },
		);
		return runtime
			.run()
			.then(() => {
				completed += 1;
				durations.push(Date.now() - agentStarted);
			})
			.catch(() => {
				failed += 1;
				durations.push(Date.now() - agentStarted);
			});
	}),
);

const totalMs = Date.now() - startedAt;
const sorted = [...durations].sort((a, b) => a - b);
const totalTurns = completed * turnsPerAgent;

const report = {
	agents,
	turnsPerAgent,
	thinkMs,
	leases: useLeases,
	completed,
	failed,
	totalTurns,
	wallMs: totalMs,
	turnsPerSecond: Number((totalTurns / (totalMs / 1000)).toFixed(1)),
	agentLatencyMs: {
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1] ?? 0,
	},
};

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
server.close();