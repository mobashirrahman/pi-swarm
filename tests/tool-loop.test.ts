import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AgentRuntime, type AgentSpec } from "../src/agent.ts";
import { AccountRegistry, type AccountRegistryEntry, type WireModel } from "../src/catalog.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { ToolExecutor, registerBuiltinTools } from "../src/tools.ts";

/**
 * End-to-end tool loop over a REAL HTTP server (only the provider is fake):
 * turn 0 returns a tool call, the runtime executes it through the journaled
 * executor, then turn 1 asserts the follow-up payload carries the assistant
 * tool_calls + the tool result message — and returns the final answer.
 */

interface CapturedRequest {
	model?: string;
	messages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>;
	tools?: unknown[];
}

/** Scripted SSE response: what the fake model replies on each request. */
type MockTurn =
	| { kind: "tool_call"; name: string; args: string }
	| { kind: "text"; content: string }
	| { kind: "empty" };

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Fake provider. `script` receives the request index and the captured
 * request (so a test can vary the reply per model or per turn).
 */
function startMockProvider(
	requests: CapturedRequest[],
	script: (turnIndex: number, request: CapturedRequest) => MockTurn,
): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
			requests.push(body);
			const turnIndex = requests.length - 1;
			const reply = script(turnIndex, body);

			res.writeHead(200, { "Content-Type": "text/event-stream" });
			if (reply.kind === "tool_call") {
				res.write(sseChunk({
					choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${turnIndex + 1}`, function: { name: reply.name, arguments: reply.args } }] } }],
				}));
				res.write(sseChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
			} else if (reply.kind === "text") {
				res.write(sseChunk({ choices: [{ delta: { content: reply.content } }] }));
				res.write(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
				res.write(sseChunk({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
			} else {
				// 200 with nothing — the reasoning-only-model defect.
				res.write(sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
			}
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

function spec(): AgentSpec {
	return {
		agentId: "tool-agent",
		task: "Use the calculator tool to compute 17*23.",
		maxTurns: 4,
		maxWallTimeMs: 30_000,
		maxProviderAttemptsPerTurn: 2,
		capabilities: ["text", "tools"],
		qualityFloor: null,
		allowUnknownQuality: true,
	};
}

describe("tool loop end-to-end (fake provider, real HTTP)", () => {
	let server: Server;
	let baseUrl: string;
	let requests: CapturedRequest[];

	/** Default script: tool call on turn 0, final answer afterwards. */
	const defaultScript = (turnIndex: number): MockTurn =>
		turnIndex === 0
			? { kind: "tool_call", name: "calculator", args: "{\"expression\":\"17*23\"}" }
			: { kind: "text", content: "The answer is 391." };

	async function start(script: (turnIndex: number, request: CapturedRequest) => MockTurn = defaultScript): Promise<void> {
		requests = [];
		const started = await startMockProvider(requests, script);
		server = started.server;
		baseUrl = started.baseUrl;
	}

	/** Wire a dispatcher + runtime against the mock provider. */
	async function buildRuntime(
		toolExecutor: ToolExecutor,
		models: WireModel[] = [{ id: "mock-model", context_length: 128_000 }],
	): Promise<{ runtime: AgentRuntime; dispatcher: Dispatcher }> {
		const accounts = new AccountRegistry();
		accounts.register({
			accountId: "mock:primary",
			providerId: "mock",
			credentialRef: "MOCK_API_KEY",
			enabled: true,
			maxConcurrency: 2,
			baseUrl,
		});
		const dispatcher = new Dispatcher({ accounts, fetchModels: async () => models });
		await dispatcher.loadCandidates();
		const runtime = new AgentRuntime(
			spec(),
			{ executeTurn: (messages, opts) => dispatcher.executeTurn(messages, opts, toolExecutor.specs()) },
			{ execute: (agentId, turnIndex, callId, tool, argsJson, signal) => toolExecutor.execute(agentId, turnIndex, callId, tool, argsJson, signal) },
		);
		return { runtime, dispatcher };
	}

	afterEach(() => {
		server.close();
	});

	it("executes the tool, feeds the result back, and completes on the follow-up turn", async () => {
		await start();
		const toolExecutor = new ToolExecutor();
		registerBuiltinTools(toolExecutor);
		const { runtime } = await buildRuntime(toolExecutor);

		const final = await runtime.run();
		expect(final).toBe("The answer is 391.");

		// Two turns: the tool call, then the follow-up carrying its result.
		expect(requests).toHaveLength(2);

		// Tools were advertised on both requests.
		expect(requests[0]?.tools).toHaveLength(3);
		expect(requests[1]?.tools).toHaveLength(3);

		// The follow-up payload must carry the assistant tool_calls and the
		// matching tool result — this is the contract providers validate.
		const followUp = requests[1]?.messages ?? [];
		const assistantWithCall = followUp.find((message) => message.role === "assistant" && message.tool_calls);
		expect(assistantWithCall?.tool_calls?.[0]?.function.name).toBe("calculator");

		const toolMessage = followUp.find((message) => message.role === "tool");
		expect(toolMessage?.tool_call_id).toBe(assistantWithCall?.tool_calls?.[0]?.id);
		// The calculator actually ran: 17*23 = 391.
		expect(JSON.parse(toolMessage?.content ?? "{}")).toEqual({ expression: "17*23", value: 391 });

		// Runtime reached a terminal state.
		expect(runtime.getState()).toBe("completed");
		expect(runtime.getTranscript().length).toBeGreaterThanOrEqual(4);
	});

	it("a tool error is surfaced to the model as content, not a turn failure", async () => {
		await start();
		// Executor with the same tool NAME but a failing implementation.
		const toolExecutor = new ToolExecutor();
		toolExecutor.register("calculator", {
			description: "always fails",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				throw new Error("calculator unavailable");
			},
		});
		const { runtime } = await buildRuntime(toolExecutor);

		// The run still completes: the failure is data the model sees.
		const final = await runtime.run();
		expect(final).toBe("The answer is 391.");

		const toolMessage = (requests[1]?.messages ?? []).find((message) => message.role === "tool");
		expect(JSON.parse(toolMessage?.content ?? "{}").error).toBe("tool_failed");
	});

	it("reroutes to another model when one returns an empty 200 (reasoning-only defect)", async () => {
		// First attempt answers empty (the reasoning-only defect); the reroute
		// must land on the other candidate and answer properly.
		await start((turnIndex) =>
			turnIndex === 0
				? { kind: "empty" }
				: { kind: "text", content: "Recovered on a healthy model." },
		);
		const toolExecutor = new ToolExecutor();
		registerBuiltinTools(toolExecutor);
		const { runtime, dispatcher } = await buildRuntime(toolExecutor, [
			{ id: "broken-model", context_length: 128_000 },
			{ id: "good-model", context_length: 128_000 },
		]);

		const final = await runtime.run();
		expect(final).toBe("Recovered on a healthy model.");
		// Exactly one model was struck and excluded as a model defect.
		expect(dispatcher.blacklist.size()).toBe(1);
		const struckKey = [...dispatcher.blacklist.snapshot().keys()][0];
		expect(struckKey).toMatch(/^mock:primary\/(broken|good)-model$/);
		// Two attempts were made: the empty one, then the healthy one.
		expect(requests).toHaveLength(2);
		expect(requests[1]?.model).not.toBe(requests[0]?.model);
	});

	it("stops early when the model repeats the same tool call forever", async () => {
		await start(() => ({ kind: "tool_call", name: "calculator", args: "{\"expression\":\"17*23\"}" }));
		const toolExecutor = new ToolExecutor();
		registerBuiltinTools(toolExecutor);
		const { runtime } = await buildRuntime(toolExecutor);

		await expect(runtime.run()).rejects.toThrow(/tool loop detected/);
		expect(runtime.getState()).toBe("failed");
		// Bounded: the guard fires well before maxTurns (4) of quota burn.
		expect(requests.length).toBeLessThanOrEqual(4);
	});

	it("cancelling mid-run aborts the agent without a provider failure", async () => {
		await start();
		const toolExecutor = new ToolExecutor();
		registerBuiltinTools(toolExecutor);
		const { runtime, dispatcher } = await buildRuntime(toolExecutor);

		const runPromise = runtime.run();
		runtime.cancel();
		await expect(runPromise).resolves.toBe("");
		expect(runtime.getState()).toBe("cancelled");
		// No circuit strike: the account is still healthy after cancellation.
		expect(dispatcher.circuit.get("mock:primary").state).toBe("closed");
	});
});