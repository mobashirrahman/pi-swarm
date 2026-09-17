import { describe, expect, it } from "vitest";
import { AgentRuntime, type AgentSpec } from "../src/agent.ts";
import type { ChatMessage, TurnOutcome } from "../src/stream.ts";

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		agentId: "runtime-test",
		task: "answer",
		maxTurns: 2,
		maxWallTimeMs: 30_000,
		maxProviderAttemptsPerTurn: 1,
		capabilities: ["text"],
		qualityFloor: null,
		allowUnknownQuality: true,
		...overrides,
	};
}

function textOutcome(content = "done"): Extract<TurnOutcome, { ok: true }> {
	return {
		ok: true,
		message: { role: "assistant", content },
		content,
		toolCalls: [],
		usage: undefined,
		quota: { quotas: [], drift: false },
		latencyMs: 1,
		timing: { latencyMs: 1, ttftMs: undefined, tokensPerSecond: undefined },
	};
}

function toolOutcome(): Extract<TurnOutcome, { ok: true }> {
	return {
		ok: true,
		message: {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call-1", type: "function", function: { name: "noop", arguments: "{}" } }],
		},
		content: "",
		toolCalls: [{ id: "call-1", name: "noop", arguments: "{}" }],
		usage: undefined,
		quota: { quotas: [], drift: false },
		latencyMs: 1,
		timing: { latencyMs: 1, ttftMs: undefined, tokensPerSecond: undefined },
	};
}

describe("AgentRuntime lifecycle", () => {
	it("keeps cancellation sticky when a successful turn resolves afterward", async () => {
		const deferred = Promise.withResolvers<{
			ok: true;
			outcome: Extract<TurnOutcome, { ok: true }>;
			accountId: string;
			modelId: string;
		}>();
		let committed = 0;
		let cancelled = 0;
		const runtime = new AgentRuntime(
			spec(),
			{ executeTurn: async () => deferred.promise },
			{ execute: async () => "ok" },
			{
				onTurnCommitted: () => { committed += 1; },
				onCancel: () => { cancelled += 1; },
			},
		);

		const running = runtime.run();
		await Promise.resolve();
		runtime.cancel();
		deferred.resolve({ ok: true, outcome: textOutcome(), accountId: "a", modelId: "m" });

		expect(await running).toBe("");
		expect(runtime.getState()).toBe("cancelled");
		expect(committed).toBe(0);
		expect(cancelled).toBe(1);
	});

	it("emits reroute metadata supplied by the dispatcher", async () => {
		const reroutes: Array<[number, string, string, string]> = [];
		const runtime = new AgentRuntime(
			spec(),
			{
				executeTurn: async () => ({
					ok: true,
					outcome: textOutcome("recovered"),
					accountId: "new-account",
					modelId: "new-model",
					reroutedFrom: { accountId: "old-account", modelId: "old-model", reason: "quota" },
				}),
			},
			{ execute: async () => "ok" },
			{ onReroute: (turn, from, to, reason) => reroutes.push([turn, from, to, reason]) },
		);

		expect(await runtime.run()).toBe("recovered");
		expect(reroutes).toEqual([[0, "old-account/old-model", "new-account/new-model", "quota"]]);
	});

	it("aborts the last tool when max turns is reached", async () => {
		let toolSignal: AbortSignal | undefined;
		const runtime = new AgentRuntime(
			spec({ maxTurns: 1 }),
			{ executeTurn: async () => ({ ok: true, outcome: toolOutcome(), accountId: "a", modelId: "m" }) },
			{ execute: async (_agentId, _turn, _callId, _tool, _args, signal) => { toolSignal = signal; return "ok"; } },
		);

		await expect(runtime.run()).rejects.toThrow("max turns exceeded");
		expect(runtime.getState()).toBe("failed");
		expect(toolSignal?.aborted).toBe(true);
	});
});
