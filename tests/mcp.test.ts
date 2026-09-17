import { describe, expect, it } from "vitest";
import { handleMessage } from "../src/mcp-server.ts";

/**
 * The MCP surface is driven through handleMessage with a fake backend, so the
 * protocol contract (methods, shapes, in-band tool errors) is pinned without
 * spawning the real stdio loop.
 */

interface FakeBackend {
	spawn(args: Record<string, unknown>): Promise<{ agentId: string; duplicate: boolean }>;
	status(agentId: string): Promise<{ state: string; finalContent?: string | undefined; failReason?: string | undefined; events: string[] }>;
	cancel(agentId: string): Promise<boolean>;
	capacity(): Promise<unknown>;
	models(args: Record<string, unknown>): Promise<unknown>;
	reset(args: Record<string, unknown>): Promise<unknown>;
}

function fakeBackend(overrides: Partial<FakeBackend> = {}): FakeBackend {
	return {
		spawn: async (args) => ({ agentId: `agent-for-${String(args["task"]).slice(0, 8)}`, duplicate: false }),
		status: async () => ({ state: "completed", finalContent: "42", events: ["agent.queued", "agent.completed"] }),
		cancel: async () => true,
		capacity: async () => [{ accountId: "fake:primary", circuit: "closed" }],
		models: async () => [{ accountId: "fake:primary", modelId: "m1", quality: 71.5, tokensPerSecond: 40 }],
		reset: async () => ({ reset: ["fake:primary"], clearedBans: 0 }),
		...overrides,
	};
}

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
	return { jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) };
}

describe("MCP protocol contract", () => {
	it("initialize advertises the tools capability and server identity", async () => {
		const result = (await handleMessage(fakeBackend() as never, rpc("initialize"))) as {
			protocolVersion: string;
			capabilities: { tools: unknown };
			serverInfo: { name: string; version: string };
		};
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.capabilities.tools).toBeDefined();
		expect(result.serverInfo.name).toBe("pi-swarm");
		expect(result.serverInfo.version).toBe("1.0.0");
	});

	it("notifications produce no response", async () => {
		expect(await handleMessage(fakeBackend() as never, rpc("notifications/initialized"))).toBeUndefined();
	});

	it("ping returns an empty result", async () => {
		expect(await handleMessage(fakeBackend() as never, rpc("ping"))).toEqual({});
	});

	it("tools/list exposes every swarm tool with a JSON schema", async () => {
		const result = (await handleMessage(fakeBackend() as never, rpc("tools/list"))) as {
			tools: Array<{ name: string; description: string; inputSchema: { type: string; required?: string[] } }>;
		};
		const names = result.tools.map((tool) => tool.name);
		expect(names).toEqual(["swarm_spawn", "swarm_wait", "swarm_status", "swarm_cancel", "swarm_capacity", "swarm_models", "swarm_reset"]);
		for (const tool of result.tools) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.inputSchema.type).toBe("object");
		}
		expect(result.tools[0]?.inputSchema.required).toEqual(["task"]);
	});

	it("tools/call returns content blocks carrying the JSON payload", async () => {
		const result = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_spawn", arguments: { task: "hello world" } }),
		)) as { content: Array<{ type: string; text: string }> };
		expect(result.content[0]?.type).toBe("text");
		expect(JSON.parse(result.content[0]!.text)).toEqual({ agentId: "agent-for-hello wo", duplicate: false });
	});

	it("swarm_status surfaces the agent's terminal answer", async () => {
		const result = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_status", arguments: { agentId: "a1" } }),
		)) as { content: Array<{ text: string }> };
		const status = JSON.parse(result.content[0]!.text) as { state: string; finalContent: string };
		expect(status.state).toBe("completed");
		expect(status.finalContent).toBe("42");
	});

	it("swarm_cancel reports whether anything was cancelled", async () => {
		const cancelled = (await handleMessage(
			fakeBackend({ cancel: async () => true }) as never,
			rpc("tools/call", { name: "swarm_cancel", arguments: { agentId: "a1" } }),
		)) as { content: Array<{ text: string }> };
		expect(JSON.parse(cancelled.content[0]!.text)).toEqual({ cancelled: true });

		const missing = (await handleMessage(
			fakeBackend({ cancel: async () => false }) as never,
			rpc("tools/call", { name: "swarm_cancel", arguments: { agentId: "nope" } }),
		)) as { content: Array<{ text: string }> };
		expect(JSON.parse(missing.content[0]!.text)).toEqual({ cancelled: false });
	});

	it("swarm_wait returns immediately for a terminal agent", async () => {
		const result = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_wait", arguments: { agentId: "a1", timeoutMs: 1_000 } }),
		)) as { content: Array<{ text: string }> };
		const status = JSON.parse(result.content[0]!.text) as { state: string };
		expect(status.state).toBe("completed");
	});

	it("swarm_wait reports timedOut when the agent never settles", async () => {
		const backend = fakeBackend({ status: async () => ({ state: "running", events: [] }) });
		const result = (await handleMessage(
			backend as never,
			rpc("tools/call", { name: "swarm_wait", arguments: { agentId: "a1", timeoutMs: 10 } }),
		)) as { content: Array<{ text: string }> };
		const status = JSON.parse(result.content[0]!.text) as { state: string; timedOut: boolean };
		expect(status.state).toBe("running");
		expect(status.timedOut).toBe(true);
	});

	it("tool failures come back in-band with isError, not as a protocol error", async () => {
		const backend = fakeBackend({
			spawn: async () => {
				throw new Error("provider exploded");
			},
		});
		const result = (await handleMessage(
			backend as never,
			rpc("tools/call", { name: "swarm_spawn", arguments: { task: "x" } }),
		)) as { content: Array<{ text: string }>; isError: boolean };
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]!.text).error).toContain("provider exploded");
	});

	it("swarm_models and swarm_reset dispatch to the backend", async () => {
		const models = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_models", arguments: { limit: 5 } }),
		)) as { content: Array<{ text: string }> };
		expect(JSON.parse(models.content[0]!.text)).toEqual([
			{ accountId: "fake:primary", modelId: "m1", quality: 71.5, tokensPerSecond: 40 },
		]);

		const reset = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_reset", arguments: { accountId: "fake:primary" } }),
		)) as { content: Array<{ text: string }> };
		expect(JSON.parse(reset.content[0]!.text)).toEqual({ reset: ["fake:primary"], clearedBans: 0 });
	});

	it("unknown methods raise so the loop can answer with an error frame", async () => {
		await expect(handleMessage(fakeBackend() as never, rpc("does/not/exist"))).rejects.toThrow(/method not found/);
	});

	it("unknown tool names fail in-band rather than crashing the server", async () => {
		const result = (await handleMessage(
			fakeBackend() as never,
			rpc("tools/call", { name: "swarm_nonsense", arguments: {} }),
		)) as { content: Array<{ text: string }>; isError: boolean };
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]!.text).error).toContain("unknown tool");
	});
});