import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AgentStore } from "../src/store.ts";
import { SwarmService } from "../src/swarm.ts";
import type { AccountRegistryEntry } from "../src/catalog.ts";

function account(baseUrl: string, accountId = "mock:primary"): AccountRegistryEntry & { baseUrl: string } {
	return {
		accountId,
		providerId: "mock",
		credentialRef: "MOCK_API_KEY",
		enabled: true,
		maxConcurrency: 4,
		baseUrl,
		category: "free",
	};
}

function candidate(accountId: string): import("../src/types.ts").Candidate {
	return {
		accountId,
		providerId: "mock",
		modelId: "mock-model",
		name: "mock-model",
		ciScore: null,
		contextWindow: 128_000,
		capabilities: { text: true, vision: false, tools: true },
	};
}

function startMockProvider(reply: (index: number) => { content: string; hold?: boolean }): Promise<{ server: Server; baseUrl: string; count: () => number }> {
	let requests = 0;
	const 	server = createServer((req, res) => {
		if (req.url?.endsWith("/models")) {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: [{ id: "mock-model", context_length: 128_000 }] }));
			});
			return;
		}
		req.resume();
		req.on("end", () => {
			const index = requests++;
			const { content, hold } = reply(index);
			if (hold) return;
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
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, count: () => requests });
		});
	});
}

describe("swarm plans (fan-out + gather)", () => {
	let server: Server | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("fans out subtasks as child agents and gathers their answers", async () => {
		const started = await startMockProvider((index) => ({ content: `answer-${index}` }));
		server = started.server;
		const service = new SwarmService({
			accounts: [account(started.baseUrl, "mock:a"), account(started.baseUrl, "mock:b"), account(started.baseUrl, "mock:c")],
		});
		service.dispatcher["candidatesCache"] = [candidate("mock:a"), candidate("mock:b"), candidate("mock:c")];

		const plan = service.spawnPlan({
			goal: "Collect numbers",
			subtasks: [{ task: "first" }, { task: "second", tierHint: "fast" }, { task: "third" }],
			defaults: { capabilities: ["text"], maxTurns: 2 },
		});
		expect(plan.planId.startsWith("plan-")).toBe(true);
		expect(plan.childIds).toHaveLength(3);
		expect(plan.duplicate).toBe(false);

		const gathered = await service.gatherPlan(plan.planId, 30_000);
		expect(gathered.state).toBe("completed");
		expect(gathered.children.map((child) => child.state)).toEqual(["completed", "completed", "completed"]);
		expect(gathered.children.map((child) => child.finalContent).sort()).toEqual(["answer-0", "answer-1", "answer-2"]);
	});

	it("queues siblings on one unknown-quota account instead of failing them", async () => {
		const started = await startMockProvider((index) => ({ content: `solo-${index}` }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl, "mock:solo")] });
		service.dispatcher["candidatesCache"] = [candidate("mock:solo")];
		const plan = service.spawnPlan({ subtasks: [{ task: "a" }, { task: "b" }], defaults: { capabilities: ["text"], maxTurns: 2 } });
		const gathered = await service.gatherPlan(plan.planId, 30_000);
		expect(gathered.state).toBe("completed");
		expect(gathered.children.map((child) => child.finalContent).sort()).toEqual(["solo-0", "solo-1"]);
	});

	it("rejects empty and oversized plans", async () => {
		const started = await startMockProvider(() => ({ content: "x" }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		expect(() => service.spawnPlan({ subtasks: [] })).toThrow(/1\.\.10/);
		expect(() => service.spawnPlan({ subtasks: Array.from({ length: 11 }, (_, i) => ({ task: `t${i}` })) })).toThrow(/1\.\.10/);
	});

	it("replays the same plan for a repeated idempotency key", async () => {
		const started = await startMockProvider(() => ({ content: "done" }));
		server = started.server;
		const service = new SwarmService({ store: new AgentStore(":memory:"), accounts: [account(started.baseUrl)] });
		const first = service.spawnPlan({ subtasks: [{ task: "a" }], idempotencyKey: "plan-7" });
		const second = service.spawnPlan({ subtasks: [{ task: "a" }], idempotencyKey: "plan-7" });
		expect(second.duplicate).toBe(true);
		expect(second.planId).toBe(first.planId);
		expect(second.childIds).toEqual(first.childIds);
	});

	it("cancelling the plan reaps every child", async () => {
		const started = await startMockProvider(() => ({ content: "never", hold: true }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl, "mock:a"), account(started.baseUrl, "mock:b")] });
		service.dispatcher["candidatesCache"] = [candidate("mock:a"), candidate("mock:b")];
		const plan = service.spawnPlan({ subtasks: [{ task: "a" }, { task: "b" }] });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(service.cancelAgent(plan.planId)).toBe(true);
		const gathered = await service.gatherPlan(plan.planId, 15_000);
		expect(gathered.children.every((child) => child.state !== "completed")).toBe(true);
		expect(gathered.children.every((child) => ["failed", "cancelled"].includes(child.state))).toBe(true);
	});
});

describe("plan request parsing", () => {
	it("accepts goals, defaults, and per-subtask overrides; rejects bad shapes", async () => {
		const mod = (await import("../src/server.ts")) as unknown as {
			parsePlanRequest: (input: Record<string, unknown>) => Record<string, unknown>;
		};
		const parsed = mod.parsePlanRequest({
			goal: "g",
			defaults: { tierHint: "fast", maxTurns: 4 },
			subtasks: [{ task: "a", qualityFloor: 70 }, { task: "b" }],
			idempotencyKey: "k",
		}) as { goal: string; defaults: { tierHint: string }; subtasks: Array<Record<string, unknown>>; idempotencyKey: string };
		expect(parsed.goal).toBe("g");
		expect(parsed.defaults.tierHint).toBe("fast");
		expect(parsed.subtasks[0]?.["qualityFloor"]).toBe(70);
		expect(parsed.subtasks[1]?.["task"]).toBe("b");
		expect(parsed.idempotencyKey).toBe("k");
		// Unspecified overrides must stay ABSENT so plan-level defaults win.
		expect(parsed.subtasks[0]).not.toHaveProperty("maxTurns");
		expect(parsed.subtasks[0]).not.toHaveProperty("capabilities");
		expect(parsed.subtasks[1]).toEqual({ task: "b" });
		expect(() => mod.parsePlanRequest({ subtasks: [] })).toThrow();
		expect(() => mod.parsePlanRequest({ subtasks: [{ task: "" }] })).toThrow();
		expect(() => mod.parsePlanRequest({ subtasks: [{ system: "no task" }] })).toThrow();
		expect(() => mod.parsePlanRequest({ subtasks: Array.from({ length: 11 }, () => ({ task: "t" })) })).toThrow();
	});
});

describe("plan runtime limits", () => {
	let server: Server | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("applies plan defaults to children that omit them, honoring subtask overrides", async () => {
		const started = await startMockProvider(() => ({ content: "child" }));
		server = started.server;
		const service = new SwarmService({
			accounts: [account(started.baseUrl, "mock:a"), account(started.baseUrl, "mock:b")],
		});
		service.dispatcher["candidatesCache"] = [candidate("mock:a"), candidate("mock:b")];
		const plan = service.spawnPlan({
			subtasks: [{ task: "a" }, { task: "b", maxTurns: 2 }],
			defaults: { capabilities: ["text"], maxTurns: 1, maxWallTimeMs: 30_000 },
		});
		const specs = plan.childIds.map((id) => service.getAgent(id)?.spec);
		expect(specs[0]?.capabilities).toEqual(["text"]);
		expect(specs[0]?.maxTurns).toBe(1);
		expect(specs[0]?.maxWallTimeMs).toBe(30_000);
		expect(specs[1]?.maxTurns).toBe(2);
		const gathered = await service.gatherPlan(plan.planId, 30_000);
		expect(gathered.state).toBe("completed");
	});

	it("returns instead of polling forever on a non-finite timeout", async () => {
		const started = await startMockProvider(() => ({ content: "never", hold: true }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl, "mock:a")] });
		service.dispatcher["candidatesCache"] = [candidate("mock:a")];
		const plan = service.spawnPlan({ subtasks: [{ task: "a" }] });
		// NaN falls back to the default budget (20s), not an endless loop.
		const at = Date.now();
		const gathered = await service.gatherPlan(plan.planId, Number.NaN);
		const elapsed = Date.now() - at;
		expect(elapsed).toBeGreaterThanOrEqual(19_000);
		expect(elapsed).toBeLessThan(26_000);
		expect(gathered.state).toBe("running");
		expect(gathered.timedOut).toBe(true);
		service.cancelAgent(plan.planId);
	}, 40_000);

	it("fails a plan holding an unreapable child instead of waiting forever", async () => {
		const started = await startMockProvider(() => ({ content: "x" }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		const at = Date.now();
		const gathered = await service.gatherPlan("plan-does-not-exist", 30_000);
		expect(Date.now() - at).toBeLessThan(5_000);
		expect(gathered.state).not.toBe("running");
	});

	it("caps concurrent live agents", async () => {
		const started = await startMockProvider(() => ({ content: "never", hold: true }));
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		const { MAX_LIVE_AGENTS } = await import("../src/swarm.ts");
		const spec = () => ({
			task: "t", maxTurns: 1, maxWallTimeMs: 60_000, maxProviderAttemptsPerTurn: 1,
			capabilities: ["text" as const], qualityFloor: null, allowUnknownQuality: true,
		});
		for (let i = 0; i < MAX_LIVE_AGENTS; i++) service.spawnAgent({ spec: spec() });
		expect(() => service.spawnAgent({ spec: spec() })).toThrow(/too many live agents/);
	});
});

describe("plan MCP wiring", () => {
	it("routes swarm_plan and swarm_gather through the backend", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const backend = {
			plan: async (args: Record<string, unknown>) => {
				calls.push({ tool: "plan", args });
				return { planId: "plan-1", childIds: ["a"], duplicate: false };
			},
			gather: async (planId: string, timeoutMs: number | undefined) => {
				calls.push({ tool: "gather", args: { planId, timeoutMs } });
				return { planId, state: "completed", children: [] };
			},
			spawn: async () => ({ agentId: "a", duplicate: false }),
			status: async () => ({ state: "completed", events: [] as string[] }),
			cancel: async () => true,
			capacity: async () => [],
			models: async () => [],
			reset: async () => ({}),
		};
		const { handleMessage } = await import("../src/mcp-server.ts");
		const planned = (await handleMessage(backend as never, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "swarm_plan", arguments: { goal: "g", subtasks: [{ task: "a" }] } },
		})) as { content: Array<{ text: string }> };
		expect(JSON.parse(planned.content[0]?.text ?? "{}")).toMatchObject({ planId: "plan-1" });
		const gathered = (await handleMessage(backend as never, {
			jsonrpc: "2.0", id: 2, method: "tools/call",
			params: { name: "swarm_gather", arguments: { planId: "plan-1", timeoutMs: 5000 } },
		})) as { content: Array<{ text: string }> };
		expect(JSON.parse(gathered.content[0]?.text ?? "{}")).toMatchObject({ state: "completed" });
		expect(calls).toMatchObject([
			{ tool: "plan" },
			{ tool: "gather", args: { planId: "plan-1", timeoutMs: 5000 } },
		]);
	});
	it("tools/list advertises the plan tools", async () => {
		const { handleMessage } = await import("../src/mcp-server.ts");
		const result = (await handleMessage({} as never, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
			tools: Array<{ name: string }>;
		};
		expect(result.tools.map((tool) => tool.name)).toContain("swarm_plan");
		expect(result.tools.map((tool) => tool.name)).toContain("swarm_gather");
	});
});
