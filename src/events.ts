/**
 * Event bus: per-agent ordered progress events for the control API.
 *
 * The plan's API surface is `GET /v1/agents/:id/events` (SSE). Events are
 * appended to a bounded per-agent ring and broadcast to live subscribers, so
 * a client that connects late still receives the agent's history — the
 * common case for a swarm, where a consumer attaches after spawning.
 *
 * Payloads carry metadata only (state, model, counts, error CLASS). Never
 * prompts, tool arguments, or response bodies.
 */

export type AgentEventType =
	| "agent.queued"
	| "agent.started"
	| "agent.state"
	| "turn.routed"
	| "turn.committed"
	| "turn.rerouted"
	| "turn.waiting_capacity"
	| "tool.executed"
	| "model.changed"
	| "agent.completed"
	| "agent.failed"
	| "agent.cancelled";

export interface AgentEvent {
	/** Monotonic per-process sequence for ordering + SSE `id:` resume. */
	seq: number;
	agentId: string;
	type: AgentEventType;
	at: number;
	/** Metadata only — never prompts, arguments, or bodies. */
	data?: Record<string, unknown>;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface Subscription {
	unsubscribe(): void;
}

/** Ring size per agent: enough history for a late-attaching consumer. */
const MAX_EVENTS_PER_AGENT = 200;

export class EventBus {
	private readonly history = new Map<string, AgentEvent[]>();
	private readonly listeners = new Map<string, Set<AgentEventListener>>();
	private seq = 0;

	emit(agentId: string, type: AgentEventType, data?: Record<string, unknown>): AgentEvent {
		this.seq += 1;
		const event: AgentEvent = { seq: this.seq, agentId, type, at: Date.now(), ...(data ? { data } : {}) };

		const ring = this.history.get(agentId) ?? [];
		ring.push(event);
		if (ring.length > MAX_EVENTS_PER_AGENT) ring.splice(0, ring.length - MAX_EVENTS_PER_AGENT);
		this.history.set(agentId, ring);

		// Snapshot: a listener that unsubscribes mid-emit mutates the underlying
		// Set while it is being iterated, which skips live listeners.
		for (const listener of [...(this.listeners.get(agentId) ?? [])]) {
			// A listener must never break the emitting path (agent progress
			// cannot depend on a consumer's health).
			try {
				listener(event);
			} catch {
				// swallowed by design
			}
		}
		return event;
	}

	/** Events recorded so far for an agent, oldest first. */
	historyFor(agentId: string): ReadonlyArray<AgentEvent> {
		return this.history.get(agentId) ?? [];
	}

	/** Events after `sinceSeq` — the SSE resume contract. */
	eventsSince(agentId: string, sinceSeq: number): ReadonlyArray<AgentEvent> {
		return this.historyFor(agentId).filter((event) => event.seq > sinceSeq);
	}

	subscribe(agentId: string, listener: AgentEventListener): Subscription {
		const set = this.listeners.get(agentId) ?? new Set<AgentEventListener>();
		set.add(listener);
		this.listeners.set(agentId, set);
		return {
			unsubscribe: () => {
				set.delete(listener);
				if (set.size === 0) this.listeners.delete(agentId);
			},
		};
	}

	/** Drop history + listeners for a finished agent (called on eviction). */
	forget(agentId: string): void {
		this.history.delete(agentId);
		this.listeners.delete(agentId);
	}

	/** Live subscriber count for an agent (diagnostics). */
	subscriberCount(agentId: string): number {
		return this.listeners.get(agentId)?.size ?? 0;
	}
}