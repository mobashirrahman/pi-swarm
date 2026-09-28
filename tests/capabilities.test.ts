import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AccountRegistry } from "../src/catalog.ts";
import { CapabilityCache, probeToolsSupport, probeVisionSupport } from "../src/capabilities.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { selectTurnCandidate, type SelectorContext, type TurnRequirements } from "../src/selector.ts";
import { AgentStore } from "../src/store.ts";
import type { ChatMessage } from "../src/stream.ts";
import type { Candidate } from "../src/types.ts";

function sseText(content: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
		+ `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
		+ "data: [DONE]\n\n";
}

function startServer(handler: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => handler(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, res));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
		});
	});
}

describe("capability probes", () => {
	it("tools probe: 200 true, 400 false, 500 inconclusive", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { server, baseUrl } = await startServer((body, res) => {
			seen.push(body);
			const status = body["model"] === "ok-model" ? 200 : body["model"] === "no-tools" ? 400 : 500;
			if (status !== 200) {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(sseText("ok"));
		});
		try {
			const endpoint = (modelId: string) => ({ baseUrl, modelId });
			expect(await probeToolsSupport(endpoint("ok-model"))).toBe(true);
			expect(await probeToolsSupport(endpoint("no-tools"))).toBe(false);
			expect(await probeToolsSupport(endpoint("broken"))).toBeNull();
			expect(seen[0]?.["tools"]).toBeDefined();
			expect(seen[0]?.["max_tokens"]).toBe(1);
		} finally {
			server.close();
		}
	});

	it("vision probe: 200 true, 422 false, network failure inconclusive", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const { server, baseUrl } = await startServer((body, res) => {
			seen.push(body);
			const status = body["model"] === "seeing" ? 200 : 422;
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end("{}");
		});
		try {
			expect(await probeVisionSupport({ baseUrl, modelId: "seeing" })).toBe(true);
			expect(await probeVisionSupport({ baseUrl, modelId: "blind" })).toBe(false);
			expect(await probeVisionSupport({ baseUrl: "http://127.0.0.1:1/v1", modelId: "seeing" })).toBeNull();
			const content = (seen[0]?.["messages"] as Array<{ content: unknown[] }>)[0]?.content;
			expect(JSON.stringify(content)).toContain("image_url");
		} finally {
			server.close();
		}
	});
});

describe("capability cache", () => {
	it("merges partial verifications and expires after the TTL", async () => {
		const mod = await import("../src/capabilities.ts");
		const cache = new CapabilityCache();
		const now = Date.now();
		cache.set("a:1", "m", { tools: true }, now);
		cache.set("a:1", "m", { vision: false }, now + 1000);
		expect(cache.get("a:1", "m", now + 2000)).toEqual({ tools: true, vision: false });
		expect(cache.get("a:1", "m", now + mod.CAPABILITY_TTL_MS + 5000)).toBeUndefined();
	});

	it("persists across cache instances through the store", () => {
		const store = new AgentStore(":memory:");
		const first = new CapabilityCache(store);
		first.set("a:1", "m", { tools: false, vision: true });
		const second = new CapabilityCache(store);
		expect(second.get("a:1", "m")).toEqual({ tools: false, vision: true });
		expect(store.getCapability("a:9", "missing")).toBeUndefined();
	});
});

describe("capability-aware selection", () => {
	const context: SelectorContext = {
		now: 1_000,
		nextCapacityAt: new Map(),
		inFlight: new Map(),
		maxConcurrency: new Map(),
		remainingRequests: new Map(),
		ewmaLatencyMs: new Map(),
		successRate: new Map(),
		blacklisted: new Set(),
		circuitOpen: new Set(),
		estimatedTokens: 100,
	};
	const base: Candidate = {
		accountId: "a", providerId: "p", modelId: "m", name: "m", ciScore: null,
		contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
	};
	const req = (capabilities: TurnRequirements["capabilities"]): TurnRequirements => ({
		capabilities, minimumContextTokens: 100, qualityFloor: null, allowUnknownQuality: true, allowPaid: false,
	});

	it("unprobed models get the benefit of the doubt; probed denials stick", () => {
		const unprobed = { ...base, capabilities: { text: true, vision: false, tools: true } };
		expect(selectTurnCandidate([unprobed], context, req(["text", "vision"])).best).not.toBeNull();
		const denied = { ...base, capabilities: { text: true, vision: false, tools: true }, capsProbed: { tools: false, vision: true } };
		const deniedVision = { ...denied, capabilities: { text: true, vision: false, tools: true } };
		expect(selectTurnCandidate([deniedVision], context, req(["text", "vision"])).best).toBeNull();
		const deniedTools = { ...base, capabilities: { text: true, vision: false, tools: false }, capsProbed: { tools: true, vision: false } };
		expect(selectTurnCandidate([deniedTools], context, req(["text", "tools"])).best).toBeNull();
		const verified = { ...base, capabilities: { text: true, vision: true, tools: true }, capsProbed: { tools: true, vision: true } };
		expect(selectTurnCandidate([verified], context, req(["text", "vision", "tools"])).best?.candidate.modelId).toBe("m");
	});

	it("text support is always required", () => {
		const noText = { ...base, capabilities: { text: false, vision: false, tools: false } };
		const result = selectTurnCandidate([noText], context, req(["text"]));
		expect(result.best).toBeNull();
		expect(result.rejected[0]?.reason).toBe("no_text");
	});
});

describe("dispatcher capability verification", () => {
	it("seeds candidates from the cache and routes around cached denials", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const { server, baseUrl } = await startServer((body, res) => {
			requests.push(body);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(sseText("done"));
		});
		try {
			const accounts = new AccountRegistry();
			accounts.register({
				accountId: "mock:primary", providerId: "mock", credentialRef: "MOCK_API_KEY",
				enabled: true, maxConcurrency: 4, baseUrl, category: "free",
			});
			const dispatcher = new Dispatcher({
				accounts,
				fetchModels: async () => [{ id: "p-model", context_length: 128_000 }, { id: "q-model", context_length: 128_000 }],
			});
			dispatcher["capabilities"].set("mock:primary", "p-model", { tools: false });
			const candidates = await dispatcher.loadCandidates();
			expect(candidates.find((c) => c.modelId === "p-model")?.capsProbed).toEqual({ tools: true, vision: false });
			const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
			const result = await dispatcher.executeTurn(messages, {
				agentId: "cap-test", turnIndex: 0, capabilities: ["text", "tools"],
				qualityFloor: null, allowUnknownQuality: true, maxAttempts: 3, signal: AbortSignal.timeout(30_000),
			});
			expect(result.ok).toBe(true);
			expect(requests.map((request) => request["model"])).toEqual(["q-model", "q-model"]);
			expect(requests[0]?.["max_tokens"]).toBe(1);
		} finally {
			server.close();
		}
	});

	it("probes an unverified model once and reroutes on denial", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const { server, baseUrl } = await startServer((body, res) => {
			requests.push(body);
			if (body["tools"] !== undefined) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end("{}");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(sseText("done"));
		});
		try {
			const accounts = new AccountRegistry();
			for (const id of ["mock:a", "mock:b"]) {
				accounts.register({
					accountId: id, providerId: "mock", credentialRef: "MOCK_API_KEY",
					enabled: true, maxConcurrency: 4, baseUrl, category: "free",
				});
			}
			const dispatcher = new Dispatcher({ accounts, fetchModels: async () => [] });
			dispatcher["candidatesCache"] = [
				{ accountId: "mock:a", providerId: "mock", modelId: "p-model", name: "p", ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true } },
				{ accountId: "mock:b", providerId: "mock", modelId: "q-model", name: "q", ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true }, capsProbed: { tools: true, vision: false } },
			];
			dispatcher["health"].set("mock:a/p-model", { latencyEwmaMs: 100, samples: 1, successes: 1, failures: 0 });
			dispatcher["health"].set("mock:b/q-model", { latencyEwmaMs: 30_000, samples: 1, successes: 1, failures: 0 });
			const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
			const result = await dispatcher.executeTurn(messages, {
				agentId: "probe-test", turnIndex: 0, capabilities: ["text", "tools"],
				qualityFloor: null, allowUnknownQuality: true, maxAttempts: 3, signal: AbortSignal.timeout(30_000),
			});
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.modelId).toBe("q-model");
			expect(requests).toHaveLength(2);
			expect(requests[0]?.["model"]).toBe("p-model");
			expect(requests[0]?.["max_tokens"]).toBe(1);
			expect(requests[1]?.["model"]).toBe("q-model");
			expect(dispatcher["capabilities"].get("mock:a", "p-model")).toEqual({ tools: false });
		} finally {
			server.close();
		}
	});
});
