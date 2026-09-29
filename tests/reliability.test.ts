import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AccountRegistryEntry } from "../src/catalog.ts";
import { runReliability, type BenchTask } from "../src/reliability.ts";
import { SwarmService } from "../src/swarm.ts";

/**
 * A fake provider whose answer depends on the model, so attribution can be
 * asserted without any real network.
 */
function startProvider(answers: Record<string, string>, failModels: Record<string, number> = {}): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; max_tokens?: number };
			const failure = failModels[body.model];
			if (failure !== undefined) {
				res.writeHead(failure, { "Content-Type": "application/json" });
				res.end("{}");
				return;
			}
			const content = answers[body.model] ?? "wrong";
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
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

function freeAccount(accountId: string, baseUrl: string, maxConcurrency = 4): AccountRegistryEntry & { baseUrl: string } {
	return {
		accountId, providerId: accountId.split(":")[0] ?? "p", credentialRef: "K",
		enabled: true, maxConcurrency, baseUrl, category: "free",
	};
}

function candidate(accountId: string, modelId: string, ciScore: number | null = null) {
	return {
		accountId, providerId: accountId.split(":")[0] ?? "p", modelId, name: modelId,
		ciScore, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
	};
}

describe("reliability benchmark", () => {
	let server: Server | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("judges answers, attributes turns, and reports latency percentiles", async () => {
		const { server: s, baseUrl } = await startProvider({ "good-model": "323" });
		server = s;
		const service = new SwarmService({ accounts: [freeAccount("a:1", baseUrl)] });
		service.dispatcher["candidatesCache"] = [candidate("a:1", "good-model")] as never;

		const tasks: BenchTask[] = [
			{ name: "t1", task: "17*19", expect: (answer) => answer.trim() === "323" },
			{ name: "t2", task: "17*19", expect: (answer) => answer.trim() === "323" },
		];
		const report = await runReliability(service, tasks, { concurrency: 2, pollMs: 20 });

		expect(report.tasks).toBe(2);
		expect(report.passed).toBe(2);
		expect(report.passRate).toBe(1);
		expect(report.accountsUsed).toBe(1);
		expect(report.byAccount[0]?.accountId).toBe("a:1");
		expect(report.byAccount[0]?.turnsServed).toBe(2);
		expect(report.byModel[0]?.model).toBe("good-model");
		expect(report.durationMs.p50).toBeGreaterThan(0);
		expect(report.outcomes.every((outcome) => outcome.served[0]?.account === "a:1")).toBe(true);
	});

	it("counts a wrong answer as a failure, not a pass", async () => {
		const { server: s, baseUrl } = await startProvider({ "good-model": "42" });
		server = s;
		const service = new SwarmService({ accounts: [freeAccount("a:1", baseUrl)] });
		service.dispatcher["candidatesCache"] = [candidate("a:1", "good-model")] as never;
		// The judge expects "323"; the model answered "42".
		const report = await runReliability(service, [{ name: "t", task: "17*19", expect: (answer) => answer.trim() === "323" }], { pollMs: 20 });
		expect(report.passed).toBe(0);
		expect(report.outcomes[0]?.judged).toBe(true);
		expect(report.outcomes[0]?.state).toBe("completed");
		expect(report.failures["wrong_answer"]).toBe(1);
	});

	it("spreads load across accounts and counts reroutes", async () => {
		// 404 (model_gone) reroutes immediately with no backoff, so the path
		// is deterministic under a loaded CPU; 429 would sleep on quota windows
		// and make this timing-dependent.
		const { server: s, baseUrl } = await startProvider({ "fast-model": "ok", "dead-model": "never" }, { "dead-model": 404 });
		server = s;
		const service = new SwarmService({ accounts: [freeAccount("a:1", baseUrl), freeAccount("b:1", baseUrl)] });
		// Frontier ranks by quality first, so the higher-scoring dead model is
		// always chosen first and the reroute onto b:1 is deterministic.
		service.dispatcher["candidatesCache"] = [
			candidate("a:1", "dead-model", 90),
			candidate("b:1", "fast-model", 50),
		] as never;
		const report = await runReliability(service, [{ name: "t", task: "hi" }], { pollMs: 20, maxProviderAttemptsPerTurn: 4 });
		expect(report.passed).toBe(1);
		expect(report.reroutes).toBeGreaterThan(0);
		expect(report.outcomes[0]?.served[0]?.account).toBe("b:1");
		expect(report.outcomes[0]?.served[0]?.reroute).toContain("a:1/dead-model");
	});

	it("times out a hung task instead of running forever", async () => {
		const server2 = createServer((req, res) => {
			req.resume();
			req.on("end", () => undefined);
			void res;
		});
		await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
		server = server2;
		const address = server2.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const service = new SwarmService({ accounts: [freeAccount("a:1", `http://127.0.0.1:${port}/v1`)] });
		service.dispatcher["candidatesCache"] = [candidate("a:1", "hung-model")] as never;
		const report = await runReliability(service, [{ name: "hang", task: "hi" }], { taskTimeoutMs: 1_200, pollMs: 20 });
		expect(report.passed).toBe(0);
		expect(report.failures["benchmark_timeout"]).toBe(1);
		expect(report.outcomes[0]?.state).toBe("cancelled");
	});

	it("respects the concurrency bound", async () => {
		const { server: s, baseUrl } = await startProvider({ "good-model": "ok" });
		server = s;
		const service = new SwarmService({ accounts: [freeAccount("a:1", baseUrl, 8)] });
		service.dispatcher["candidatesCache"] = [candidate("a:1", "good-model")] as never;
		const tasks = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, task: "hi" }));
		const report = await runReliability(service, tasks, { concurrency: 2, pollMs: 20 });
		expect(report.concurrency).toBe(2);
		expect(report.tasks).toBe(8);
		expect(report.passed).toBe(8);
	});

	it("refuses an empty task set", async () => {
		const service = new SwarmService({ accounts: [] });
		await expect(runReliability(service, [])).rejects.toThrow(/at least one task/);
	});
});
