/**
 * Crash recovery: reconcile durable state after a restart.
 *
 * What is recoverable:
 *  - Agent rows in a non-terminal state (queued/running/waiting_capacity)
 *    were interrupted mid-flight. They are marked failed with a stable
 *    reason and their durable transcript is preserved for inspection.
 *  - Tool journal entries still in "running" mean the process died between
 *    the side-effect attempt and its outcome. They are reported as
 *    "uncertain" — NEVER auto-re-run (acceptance #8: no duplicated side
 *    effects).
 *
 * What is NOT attempted: resuming an interrupted agent automatically. The
 * plan requires explicit inspection first; a resumed agent could duplicate
 * tool side effects whose outcome we cannot confirm.
 */

import type { AgentRow, AgentStore } from "./store.ts";

export interface UncertainToolCall {
	agentId: string;
	executionId: string;
	tool: string;
}

export interface RecoveryReport {
	interruptedAgents: Array<{ agentId: string; previousState: string; transcriptMessages: number }>;
	uncertainToolCalls: UncertainToolCall[];
}

/**
 * Reconcile store state after a restart. Idempotent: running it twice
 * produces no additional changes (agents are already terminal).
 */
export function recoverInterrupted(store: AgentStore, now: number = Date.now()): RecoveryReport {
	const report: RecoveryReport = { interruptedAgents: [], uncertainToolCalls: [] };

	for (const agent of store.recoverableAgents()) {
		const transcript = store.loadTranscript(agent.agentId);
		store.upsertAgent({
			...agent,
			state: "failed",
			updatedAt: now,
			failReason: "interrupted_by_restart",
		});
		report.interruptedAgents.push({
			agentId: agent.agentId,
			previousState: agent.state,
			transcriptMessages: transcript.length,
		});
	}

	report.uncertainToolCalls = store.uncertainToolCalls();
	return report;
}

/** Agent rows whose transcript survived a crash, for post-mortem inspection. */
export function interruptedWithTranscript(store: AgentStore): AgentRow[] {
	return store
		.listAgents()
		.filter((agent) => agent.failReason === "interrupted_by_restart" && store.loadTranscript(agent.agentId).length > 0);
}