import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AgentStore } from "../src/store.ts";
import { SwarmService } from "../src/swarm.ts";
import type { AgentSpec } from "../src/agent.ts";
import type { AccountRegistryEntry } from "../src/catalog.ts";

function startProvider(): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
			if (body.model === "hang-model") return;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`);
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

function account(baseUrl: string): AccountRegistryEntry & { baseUrl: string } {
	return {
		accountId: "mock:a", providerId: "mock", credentialRef: "MOCK_API_KEY",
		enabled: true, maxConcurrency: 4, baseUrl, category: "free",
	};
}

function spec(task: string, overrides: Partial<AgentSpec> = {}): Omit<AgentSpec, "agentId"> {
	return {
		task,
		maxTurns: 1,
		maxWallTimeMs: 30_000,
		maxProviderAttemptsPerTurn: 1,
		capabilities: ["text"],
		qualityFloor: null,
		allowUnknownQuality: true,
		...overrides,
	};
}

describe("listAgents", () => {
	let server: Server | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("lists live agents and omits finished ones by default", async () => {
		const started = await startProvider();
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		service.dispatcher["candidatesCache"] = [{
			accountId: "mock:a", providerId: "mock", modelId: "m", name: "m",
			ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
		}] as never;

		const { agentId } = service.spawnAgent({ spec: spec("first task\nsecond line") });
		for (let i = 0; i < 60 && service.getAgent(agentId)?.state !== "completed"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(service.getAgent(agentId)?.state).toBe("completed");

		// A second agent that never settles stays live.
		const live = service.spawnAgent({ spec: spec("live task") });
		const rows = service.listAgents();
		expect(rows.map((row) => row.agentId)).toEqual([live.agentId]);
		expect(rows[0]?.state).toBe("running");
		expect(rows[0]?.task).toBe("live task");
		expect(rows[0]?.parentAgentId).toBeNull();
	});

	it("includes finished agents on request, with answer size and failure reason", async () => {
		const started = await startProvider();
		server = started.server;
		const store = new AgentStore(":memory:");
		const service = new SwarmService({ store, accounts: [account(started.baseUrl)] });
		service.dispatcher["candidatesCache"] = [{
			accountId: "mock:a", providerId: "mock", modelId: "m", name: "m",
			ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
		}] as never;
		const { agentId } = service.spawnAgent({ spec: spec("done task") });
		for (let i = 0; i < 60 && service.getAgent(agentId)?.state !== "completed"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const all = service.listAgents({ state: "all" });
		expect(all).toHaveLength(1);
		expect(all[0]?.state).toBe("completed");
		expect(all[0]?.chars).toBe("answer".length);
	});

	it("scopes to one parent so a plan lists only its own children", async () => {
		const started = await startProvider();
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		service.dispatcher["candidatesCache"] = [{
			accountId: "mock:a", providerId: "mock", modelId: "m", name: "m",
			ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
		}] as never;
		const first = service.spawnPlan({ subtasks: [{ task: "a" }] });
		const second = service.spawnPlan({ subtasks: [{ task: "b" }] });
		const mine = service.listAgents({ parentAgentId: first.planId });
		expect(mine).toHaveLength(1);
		expect(mine[0]?.agentId).toBe(first.childIds[0]);
		expect(mine[0]?.parentAgentId).toBe(first.planId);
		expect(service.listAgents({ parentAgentId: second.planId })[0]?.agentId).toBe(second.childIds[0]);
	});

	it("truncates a long task preview and caps the limit", () => {
		const service = new SwarmService({ accounts: [] });
		const rows = service.listAgents({ limit: 5 });
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeLessThanOrEqual(5);
	});

	it("previews only the first non-empty line", async () => {
		const started = await startProvider();
		server = started.server;
		const service = new SwarmService({ accounts: [account(started.baseUrl)] });
		service.dispatcher["candidatesCache"] = [{
			accountId: "mock:a", providerId: "mock", modelId: "hang", name: "hang",
			ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
		}] as never;
		const long = "x".repeat(400);
		const { agentId } = service.spawnAgent({ spec: spec(`\n\n${long}\nrest`) });
		const rows = service.listAgents();
		expect(rows[0]?.agentId).toBe(agentId);
		expect(rows[0]?.task.length).toBeLessThanOrEqual(120);
		expect(rows[0]?.task.endsWith("...")).toBe(true);
		service.cancelAgent(agentId);
	});

	it("is reachable through the MCP tool and the HTTP collection", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const backend = {
			agents: async (args: Record<string, unknown>) => {
				calls.push(args);
				return { agents: [{ agentId: "a1", state: "running", task: "t" }] };
			},
			spawn: async () => ({ agentId: "a", duplicate: false }),
			plan: async () => ({ planId: "p", childIds: [], duplicate: false }),
			gather: async () => ({}),
			doctor: async () => ({}),
			status: async () => ({ state: "completed", events: [] }),
			cancel: async () => true,
			capacity: async () => [],
			models: async () => [],
			reset: async () => ({}),
		};
		const { handleMessage } = await import("../src/mcp-server.ts");
		const result = (await handleMessage(backend as never, {
			jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "swarm_agents", arguments: { state: "all", parentAgentId: "plan-1", limit: 5 } },
		})) as { content: Array<{ text: string }> };
		expect(JSON.parse(result.content[0]?.text ?? "{}").agents).toHaveLength(1);
		expect(calls[0]).toMatchObject({ state: "all", parentAgentId: "plan-1", limit: 5 });
		// Junk args are dropped, not forwarded.
		await handleMessage(backend as never, {
			jsonrpc: "2.0", id: 2, method: "tools/call",
			params: { name: "swarm_agents", arguments: { state: "bogus", limit: "many" } },
		});
		expect(calls[1]).toEqual({});
		const tools = (await handleMessage(backend as never, { jsonrpc: "2.0", id: 3, method: "tools/list" })) as {
			tools: Array<{ name: string }>;
		};
		expect(tools.tools.map((tool) => tool.name)).toContain("swarm_agents");
	});
});
