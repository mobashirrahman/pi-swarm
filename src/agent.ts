/**
 * Agent runtime: the turn loop for one agent.
 *
 * Correctness contract (the plan's core):
 *  - Every model turn goes through the dispatcher (lease → send → commit).
 *  - Streamed assistant output is STAGED: nothing enters the durable
 *    transcript and no tool executes until the stream ends cleanly.
 *  - A failed turn replays the COMMITTED transcript on a rerouted account.
 *  - Cancellation is never a strike and always wins over in-flight work.
 *
 * v1 executes a single user task conversation; tool execution is a stub
 * boundary (report calls to the caller) — real tool runtime lands with the
 * isolated-workspace phase.
 */

import { createLogger } from "./logger.ts";
import type { ChatMessage, TurnOutcome } from "./stream.ts";

const _logger = createLogger("agent");

export type AgentState = "queued" | "running" | "waiting_capacity" | "completed" | "failed" | "cancelled";

/**
 * Consecutive turns that may repeat the SAME tool call before the run is
 * declared stuck. 3 allows one legitimate retry after a tool error.
 */
const MAX_REPEATED_TOOL_TURNS = 3;

export interface AgentSpec {
	agentId: string;
	/** Parent agent in a swarm tree — cancelling the parent cancels this one. */
	parentAgentId?: string | undefined;
	/** Task prompt (first user message). */
	task: string;
	system?: string | undefined;
	maxTurns: number;
	maxWallTimeMs: number;
	/** Per-turn provider attempt cap. */
	maxProviderAttemptsPerTurn: number;
	capabilities: Array<"text" | "vision" | "tools">;
	qualityFloor: number | null;
	allowUnknownQuality: boolean;
}

export interface AgentEvents {
	onStateChange?: ((state: AgentState, agentId: string) => void) | undefined;
	onTurnCommitted?: ((turnIndex: number, content: string) => void) | undefined;
	onToolResults?: ((turnIndex: number, count: number) => void) | undefined;
	onReroute?: ((turnIndex: number, from: string, to: string, reason: string) => void) | undefined;
	onComplete?: ((finalContent: string) => void) | undefined;
	onFail?: ((reason: string) => void) | undefined;
}

/** The dispatcher interface the runtime depends on (DI boundary for tests). */
export interface TurnDispatcher {
	/**
	 * Execute one model turn against the best eligible candidate, rerouting
	 * on retryable failure. Resolves with the committed assistant content,
	 * or rejects with a terminal reason.
	 */
	runTurn(messages: ReadonlyArray<ChatMessage>, spec: AgentSpec, turnIndex: number, signal: AbortSignal): Promise<TurnOutcome & { ok: true } | never>;
}

/**
 * Minimal agent loop: send transcript, receive staged turn, commit,
 * repeat until the model produces a final answer (no tool calls) or a
 * limit is hit.
 */
export class AgentRuntime {
	private state: AgentState = "queued";
	private readonly transcript: ChatMessage[] = [];
	private readonly abortController = new AbortController();
	private readonly deadline: number;
	/** Loop guard: signature + count of consecutive identical tool turns. */
	private lastToolSignature = "";
	private repeatedToolTurns = 0;

	constructor(
		private readonly spec: AgentSpec,
		private readonly dispatcher: {
			executeTurn: (
				messages: ReadonlyArray<ChatMessage>,
				opts: {
					agentId: string;
					turnIndex: number;
					capabilities: AgentSpec["capabilities"];
					qualityFloor: number | null;
					allowUnknownQuality: boolean;
					maxAttempts: number;
					signal: AbortSignal;
				},
			) => Promise<{ ok: true; outcome: Extract<TurnOutcome, { ok: true }>; accountId: string; modelId: string } | { ok: false; reason: string }>;
		},
		private readonly toolExecutor: {
			execute: (agentId: string, turnIndex: number, callId: string, tool: string, argsJson: string, signal: AbortSignal) => Promise<string>;
		},
		private readonly events: AgentEvents = {},
	) {
		this.deadline = Date.now() + spec.maxWallTimeMs;
	}

	getState(): AgentState {
		return this.state;
	}

	getTranscript(): ReadonlyArray<ChatMessage> {
		return this.transcript;
	}

	cancel(): void {
		if (this.isTerminal(this.state)) return;
		this.abortController.abort();
		this.transition("cancelled");
	}

	private isTerminal(state: AgentState): boolean {
		return state === "completed" || state === "failed" || state === "cancelled";
	}

	private transition(next: AgentState): void {
		if (this.state === next) return;
		this.state = next;
		this.events.onStateChange?.(next, this.spec.agentId);
	}

	/** Drive the agent to completion. Resolves with final assistant content. */
	async run(): Promise<string> {
		if (this.state !== "queued") {
			throw new Error(`agent ${this.spec.agentId} already ${this.state}`);
		}
		this.transition("running");

		const systemMessage: ChatMessage | undefined = this.spec.system
			? { role: "system", content: this.spec.system }
			: undefined;
		if (systemMessage) this.transcript.push(systemMessage);
		this.transcript.push({ role: "user", content: this.spec.task });

		for (let turn = 0; turn < this.spec.maxTurns; turn++) {
			if (this.abortController.signal.aborted) return this.abortFinal();
			if (Date.now() > this.deadline) {
				this.transition("failed");
				this.events.onFail?.("wall_time_exceeded");
				throw new Error("wall time exceeded");
			}

			this.transition("running");
			const result = await this.dispatcher.executeTurn([...this.transcript], {
				agentId: this.spec.agentId,
				turnIndex: turn,
				capabilities: this.spec.capabilities,
				qualityFloor: this.spec.qualityFloor,
				allowUnknownQuality: this.spec.allowUnknownQuality,
				maxAttempts: this.spec.maxProviderAttemptsPerTurn,
				signal: this.abortController.signal,
			});

			if (!result.ok) {
				if (this.abortController.signal.aborted) return this.abortFinal();
				this.transition("failed");
				this.events.onFail?.(result.reason);
				throw new Error(result.reason);
			}

			// Commit: staged output is now durable in the transcript.
			this.transcript.push(result.outcome.message);
			this.events.onTurnCommitted?.(turn, result.outcome.content);

			// No tool calls → final answer.
			if (result.outcome.toolCalls.length === 0) {
				this.transition("completed");
				this.events.onComplete?.(result.outcome.content);
				return result.outcome.content;
			}

			// Execute each tool call through the journaled executor, append
			// results as tool messages, then continue to the next turn — the
			// model sees its own tool results in the transcript.
			const callSignature = result.outcome.toolCalls
				.map((call) => `${call.name}:${call.arguments}`)
				.sort()
				.join("|");
			if (callSignature === this.lastToolSignature) {
				this.repeatedToolTurns += 1;
			} else {
				this.repeatedToolTurns = 1;
				this.lastToolSignature = callSignature;
			}
			// Loop guard: a model that keeps issuing the SAME call is stuck
			// (observed live: a reasoning-only model re-calling calculator
			// until maxTurns, burning quota each turn). Stop early and say so.
			if (this.repeatedToolTurns > MAX_REPEATED_TOOL_TURNS) {
				this.transition("failed");
				this.events.onFail?.("tool_loop_detected");
				throw new Error("tool loop detected: repeated identical tool call");
			}

			for (const call of result.outcome.toolCalls) {
				if (this.abortController.signal.aborted) return this.abortFinal();
				const toolResult = await this.toolExecutor.execute(
					this.spec.agentId,
					turn,
					call.id,
					call.name,
					call.arguments,
					this.abortController.signal,
				);
				this.transcript.push({ role: "tool", content: toolResult, tool_call_id: call.id });
			}
			this.events.onToolResults?.(turn, result.outcome.toolCalls.length);
		}

		this.transition("failed");
		this.events.onFail?.("max_turns_exceeded");
		throw new Error("max turns exceeded");
	}

	private abortFinal(): string {
		this.transition("cancelled");
		return "";
	}
}
