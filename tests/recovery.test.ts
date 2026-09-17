import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/store.ts";
import { recoverInterrupted } from "../src/recovery.ts";
import type { AgentSpec } from "../src/agent.ts";

function spec(agentId: string): AgentSpec {
	return {
		agentId,
		task: "do the thing",
		maxTurns: 3,
		maxWallTimeMs: 60_000,
		maxProviderAttemptsPerTurn: 3,
		capabilities: ["text"],
		qualityFloor: null,
		allowUnknownQuality: true,
	};
}

describe("crash recovery", () => {
	let dir: string;
	let store: AgentStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-swarm-recovery-"));
		store = new AgentStore(join(dir, "test.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("marks a mid-flight agent as interrupted and preserves its transcript", () => {
		store.upsertAgent({ agentId: "a1", spec: spec("a1"), state: "running", createdAt: 1, updatedAt: 1 });
		store.appendTranscriptMessage("a1", 0, { role: "user", content: "hello" });
		store.appendTranscriptMessage("a1", 10, { role: "assistant", content: "working on it" });

		const report = recoverInterrupted(store, 5000);
		expect(report.interruptedAgents).toEqual([{ agentId: "a1", previousState: "running", transcriptMessages: 2 }]);

		const recovered = store.getAgent("a1");
		expect(recovered?.state).toBe("failed");
		expect(recovered?.failReason).toBe("interrupted_by_restart");
		// Transcript survived — post-mortem inspection is possible.
		expect(store.loadTranscript("a1").map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("leaves terminal agents untouched", () => {
		store.upsertAgent({ agentId: "done", spec: spec("done"), state: "completed", createdAt: 1, updatedAt: 1, finalContent: "ok" });
		store.upsertAgent({ agentId: "dead", spec: spec("dead"), state: "failed", createdAt: 1, updatedAt: 1, failReason: "auth" });

		const report = recoverInterrupted(store, 5000);
		expect(report.interruptedAgents).toEqual([]);
		expect(store.getAgent("done")?.finalContent).toBe("ok");
		expect(store.getAgent("dead")?.failReason).toBe("auth");
	});

	it("is idempotent — a second run changes nothing", () => {
		store.upsertAgent({ agentId: "a1", spec: spec("a1"), state: "running", createdAt: 1, updatedAt: 1 });
		const first = recoverInterrupted(store, 5000);
		const second = recoverInterrupted(store, 6000);
		expect(first.interruptedAgents).toHaveLength(1);
		expect(second.interruptedAgents).toEqual([]);
	});

	it("reports tool calls left running as uncertain (never re-run)", () => {
		store.toolBegin("a1:0:call-1", "fetch_text", JSON.stringify({ url: "https://example.com" }), 1);
		store.toolBegin("a1:0:call-2", "calculator", JSON.stringify({ expression: "2+2" }), 1);
		store.toolComplete("a1:0:call-2", JSON.stringify({ value: 4 }), 2);

		const report = recoverInterrupted(store, 5000);
		expect(report.uncertainToolCalls).toEqual([
			{ agentId: "a1", executionId: "a1:0:call-1", tool: "fetch_text" },
		]);
		// The completed one is NOT uncertain.
		expect(store.toolLookup("a1:0:call-2")?.status).toBe("completed");
	});

	it("persists the tool journal across a store reopen (same file)", () => {
		const path = join(dir, "shared.db");
		const first = new AgentStore(path);
		first.toolBegin("a1:0:c", "echo", "{}", 1);
		first.close();

		const second = new AgentStore(path);
		expect(second.toolLookup("a1:0:c")?.status).toBe("running"); // → uncertain on recovery
		second.toolComplete("a1:0:c", JSON.stringify({ echoed: "hi" }), 2);
		expect(second.toolLookup("a1:0:c")?.resultJson).toBe(JSON.stringify({ echoed: "hi" }));
		second.close();
	});

	it("transcript survives a store reopen", () => {
		const path = join(dir, "transcript.db");
		const first = new AgentStore(path);
		first.upsertAgent({ agentId: "a1", spec: spec("a1"), state: "running", createdAt: 1, updatedAt: 1 });
		first.appendTranscriptMessage("a1", 0, { role: "user", content: "q" });
		first.appendTranscriptMessage("a1", 10, {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: "{}" } }],
		});
		first.close();

		const second = new AgentStore(path);
		const transcript = second.loadTranscript("a1");
		expect(transcript).toHaveLength(2);
		expect(transcript[1]?.tool_calls?.[0]?.function.name).toBe("calculator");
		second.close();
	});
});