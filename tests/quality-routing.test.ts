import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { AccountRegistry } from "../src/catalog.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { selectTurnCandidate, type SelectorContext, type TurnRequirements } from "../src/selector.ts";
import type { ChatMessage } from "../src/stream.ts";
import type { Candidate } from "../src/types.ts";

const context: SelectorContext = {
	now: 1_000,
	nextCapacityAt: new Map(),
	inFlight: new Map(),
	maxConcurrency: new Map(),
	remainingRequests: new Map(),
	ewmaLatencyMs: new Map([["a/best", 30_000], ["a/near", 2_000], ["a/fast", 100], ["a/unknown", 1]]),
	successRate: new Map(),
	blacklisted: new Set(),
	circuitOpen: new Set(),
	estimatedTokens: 100,
};
const requirements: TurnRequirements = {
	capabilities: ["text"], minimumContextTokens: 100, qualityFloor: null, allowUnknownQuality: true, allowPaid: false,
};
function candidate(modelId: string, ciScore: number | null): Candidate {
	return { accountId: "a", providerId: "p", modelId, name: modelId, ciScore, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true } };
}
const candidates = [candidate("best", 90), candidate("near", 85), candidate("fast", 84.9), candidate("unknown", null)];

describe("quality-first routing", () => {
	it("defaults to the best quality despite much faster alternatives", () => {
		expect(selectTurnCandidate(candidates, context, requirements).best?.candidate.modelId).toBe("best");
	});
	it("rejects unknown quality even without a floor", () => {
		const result = selectTurnCandidate([candidate("unknown", null)], context, { ...requirements, allowUnknownQuality: false });
		expect(result.best).toBeNull();
		expect(result.rejected[0]?.reason).toBe("unknown_quality");
	});
	it("fast tier picks the quickest model above the quality floor", () => {
		const result = selectTurnCandidate(candidates, context, { ...requirements, tierHint: "fast", qualityFloor: 84 });
		expect(result.best?.candidate.modelId).toBe("unknown");
	});
	it("fast tier still rejects models below the floor", () => {
		const result = selectTurnCandidate(candidates, context, { ...requirements, tierHint: "fast", qualityFloor: 84, allowUnknownQuality: false });
		expect(result.best?.candidate.modelId).toBe("fast");
	});
	it("balanced tier keeps candidates within the band of the best model", () => {
		const result = selectTurnCandidate(candidates, context, { ...requirements, tierHint: "balanced" });
		// best and near are within the band; near is 15× faster, so it wins on
		// finish time while the out-of-band fast model ranks below both.
		expect(result.best?.candidate.modelId).toBe("near");
		const order = result.ranked.map((r) => r.candidate.modelId);
		expect(order.indexOf("best")).toBeLessThan(order.indexOf("fast"));
		expect(order.indexOf("near")).toBeLessThan(order.indexOf("fast"));
	});
	it("frontier tier ranks by quality before finish time", () => {
		const order = selectTurnCandidate(candidates, context, { ...requirements, tierHint: "frontier" }).ranked.map((r) => r.candidate.modelId);
		expect(order.indexOf("best")).toBeLessThan(order.indexOf("near"));
		expect(order.indexOf("near")).toBeLessThan(order.indexOf("fast"));
	});
	it("honors a chosen quality metric over the default coding index", () => {
	const withScores: Candidate[] = [
		{ ...candidate("coder", 85), qualityScores: { source: "openrouter", confidence: "exact", codingIndex: 85, intelligenceIndex: 40 } },
		{ ...candidate("sage", 60), qualityScores: { source: "openrouter", confidence: "exact", codingIndex: 60, intelligenceIndex: 95 } },
	];
		const pick = (metric: "codingIndex" | "intelligenceIndex") =>
			selectTurnCandidate(withScores, context, { ...requirements, tierHint: "frontier", qualityMetric: metric }).best?.candidate.modelId;
		expect(pick("codingIndex")).toBe("coder");
		expect(pick("intelligenceIndex")).toBe("sage");
	});
});

describe("spec and view wiring", () => {
	it("MCP spawn forwards quality settings through the backend", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const backend = {
			spawn: async (args: Record<string, unknown>) => {
				captured.push(args);
				return { agentId: "a1", duplicate: false };
			},
			status: async () => ({ state: "completed", events: [] }),
			cancel: async () => true,
			capacity: async () => [],
			models: async () => [],
			reset: async () => ({}),
		};
		const { handleMessage } = await import("../src/mcp-server.ts");
		await handleMessage(backend as never, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "swarm_spawn", arguments: { task: "t", tierHint: "fast", qualityMetric: "intelligenceIndex", qualityFloor: 70, allowUnknownQuality: false } },
		});
		expect(captured[0]).toMatchObject({ tierHint: "fast", qualityMetric: "intelligenceIndex", qualityFloor: 70, allowUnknownQuality: false });
	});
	it("tools/list advertises the quality parameters", async () => {
		const { handleMessage } = await import("../src/mcp-server.ts");
		const result = (await handleMessage({ status: async () => ({ state: "completed", events: [] }) } as never, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
		};
		const spawn = result.tools.find((tool) => tool.name === "swarm_spawn");
		expect(spawn?.inputSchema.properties["tierHint"]).toBeDefined();
		expect(spawn?.inputSchema.properties["qualityFloor"]).toBeDefined();
		expect(spawn?.inputSchema.properties["allowUnknownQuality"]).toBeDefined();
		expect(spawn?.inputSchema.properties["qualityMetric"]).toBeDefined();
	});
});

describe("tierHint end-to-end (dispatcher, fake provider, real HTTP)", () => {
	it("frontier sends to the best model while fast sends to the quickest", async () => {
		const requests: Array<{ model?: string }> = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk as Buffer));
			req.on("end", () => {
				requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const accounts = new AccountRegistry();
			accounts.register({
				accountId: "mock:primary",
				providerId: "mock",
				credentialRef: "MOCK_API_KEY",
				enabled: true,
				maxConcurrency: 4,
				baseUrl: `http://127.0.0.1:${port}/v1`,
				category: "free",
			});
			const dispatcher = new Dispatcher({ accounts, fetchModels: async () => [] });
			const scored = (modelId: string, codingIndex: number): Candidate => ({
				accountId: "mock:primary",
				providerId: "mock",
				modelId,
				name: modelId,
				ciScore: null,
				qualityScores: { source: "openrouter", confidence: "exact", codingIndex },
				contextWindow: 128_000,
				capabilities: { text: true, vision: false, tools: true },
			});
			dispatcher["candidatesCache"] = [scored("slow-best", 90), scored("fast-ok", 60)];
			dispatcher["health"].set("mock:primary/slow-best", { latencyEwmaMs: 30_000, samples: 1, successes: 1, failures: 0 });
			dispatcher["health"].set("mock:primary/fast-ok", { latencyEwmaMs: 100, samples: 1, successes: 1, failures: 0 });
			const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
			const run = (tierHint: "frontier" | "fast") =>
				dispatcher.executeTurn(messages, {
					agentId: "tier-probe",
					turnIndex: 0,
					capabilities: ["text"],
					tierHint,
					qualityMetric: "codingIndex",
					qualityFloor: null,
					allowUnknownQuality: true,
					maxAttempts: 3,
					signal: AbortSignal.timeout(30_000),
				});
			const frontier = await run("frontier");
			expect(frontier.ok).toBe(true);
			const fast = await run("fast");
			expect(fast.ok).toBe(true);
			expect(requests.map((request) => request.model)).toEqual(["slow-best", "fast-ok"]);
		} finally {
			server.close();
		}
	});
});

describe("HTTP spec parsing", () => {
	it("accepts quality settings and rejects unknown tier/metric values", async () => {
		const mod = (await import("../src/server.ts")) as unknown as { parseSpec: (input: Record<string, unknown>) => Record<string, unknown> };
		const spec = mod.parseSpec({ task: "t", tierHint: "fast", qualityMetric: "agenticIndex", qualityFloor: 55, allowUnknownQuality: false });
		expect(spec).toMatchObject({ tierHint: "fast", qualityMetric: "agenticIndex", qualityFloor: 55, allowUnknownQuality: false });
		const coerced = mod.parseSpec({ task: "t", tierHint: "bogus", qualityMetric: "bogus", qualityFloor: "not-a-number" });
		expect(coerced["tierHint"]).toBeUndefined();
		expect(coerced["qualityMetric"]).toBeUndefined();
		expect(coerced["qualityFloor"]).toBeNull();
	});
});
