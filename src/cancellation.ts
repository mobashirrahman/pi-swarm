/**
 * Cancellation tree: cancelling a parent agent cancels every descendant
 * (the plan's recursive-cancel contract, acceptance #8 family).
 *
 * Model: spawn-time parent link (`parentAgentId` in the spec). The tree
 * holds only live runtimes; completed/failed/cancelled agents drop out —
 * cancelling an already-terminal child is a no-op by design.
 *
 * Propagation order: children FIRST, then the parent's own abort — a child
 * mid-tool-call observes its own abort signal before the parent's terminal
 * transition could mask it.
 */

import type { AgentRuntime } from "./agent.ts";

export class CancellationTree {
	/** agentId → parent agentId (only agents that declared one). */
	private readonly parents = new Map<string, string>();
	/** agentId → live runtime. */
	private readonly runtimes = new Map<string, AgentRuntime>();

	register(agentId: string, parentAgentId: string | undefined, runtime: AgentRuntime): void {
		this.runtimes.set(agentId, runtime);
		if (parentAgentId) this.parents.set(agentId, parentAgentId);
	}

	unregister(agentId: string): void {
		this.runtimes.delete(agentId);
		this.parents.delete(agentId);
	}

	/**
	 * All live descendants of an agent, deepest-first (post-order): every
	 * node appears AFTER its own descendants, so a child's abort always
	 * precedes its parent's cancel.
	 */
	descendants(agentId: string): string[] {
		const result: string[] = [];
		const visit = (parent: string): void => {
			for (const [child, childParent] of this.parents) {
				if (childParent !== parent || !this.runtimes.has(child)) continue;
				visit(child);
				result.push(child);
			}
		};
		visit(agentId);
		return result;
	}

	/**
	 * Cancel an agent and every live descendant. Children cancel first.
	 * Returns all cancelled ids (parent last) — empty when the agent was
	 * not live.
	 */
	cancelTree(agentId: string): string[] {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return [];
		const descendants = this.descendants(agentId);
		const cancelled: string[] = [];
		for (const child of descendants) {
			const childRuntime = this.runtimes.get(child);
			if (childRuntime) {
				childRuntime.cancel();
				cancelled.push(child);
			}
		}
		runtime.cancel();
		cancelled.push(agentId);
		return cancelled;
	}

	/** Live agent ids (for status views). */
	live(): string[] {
		return [...this.runtimes.keys()];
	}

	/** Direct runtime lookup for live agents. */
	lookup(agentId: string): AgentRuntime | undefined {
		return this.runtimes.get(agentId);
	}
}
