/**
 * Swarm service: wires accounts + dispatcher + store + queue into the
 * control surface the orchestrator consumes.
 *
 * API (v1, in-process — HTTP server wraps this in server.ts):
 *   spawnAgent(spec, idempotencyKey?) → agentId  (queued; runs concurrently)
 *   getAgent(agentId)                 → status row + transcript
 *   cancelAgent(agentId)              → recursive cancel
 *   capacity()                        → per-account quota/circuit view
 */

import { AgentRuntime, type AgentSpec, type AgentState } from "./agent.ts";
import { AccountRegistry, resolveKey, type AccountRegistryEntry, type WireModel } from "./catalog.ts";
import { availableSeeds } from "./providers.ts";
import { createLogger } from "./logger.ts";
import { Dispatcher } from "./dispatcher.ts";
import { ToolExecutor, registerBuiltinTools, registerWorkspaceTools } from "./tools.ts";
import { CancellationTree } from "./cancellation.ts";
import { PersistentToolJournal } from "./tool-journal.ts";
import { EventBus } from "./events.ts";
import type { LeaseStore } from "./leases.ts";
import type { Workspace } from "./workspace.ts";
import { AgentStore, type AgentRow } from "./store.ts";
import type { ChatMessage } from "./stream.ts";

const _logger = createLogger("swarm");

export interface SpawnRequest {
	spec: Omit<AgentSpec, "agentId"> & { agentId?: string | undefined };
	/** Client-supplied dedupe key (e.g. "parent-42:research"). */
	idempotencyKey?: string | undefined;
}

export interface SpawnResult {
	agentId: string;
	/** True when an existing agent satisfied the idempotency key. */
	duplicate: boolean;
}

export interface CapacityView {
	accountId: string;
	providerId: string;
	enabled: boolean;
	circuit: string;
	cooldownUntil: number;
	inFlight: number;
	remainingMinute: number | undefined;
	models: number;
}

const DEFAULT_SPEC: Omit<AgentSpec, "agentId" | "task"> = {
	maxTurns: 12,
	maxWallTimeMs: 600_000,
	maxProviderAttemptsPerTurn: 3,
	capabilities: ["text", "tools"],
	qualityFloor: null,
	allowUnknownQuality: true,
};

export class SwarmService {
	readonly accounts: AccountRegistry;
	readonly dispatcher: Dispatcher;
	private readonly store: AgentStore | undefined;
	private readonly toolExecutor: ToolExecutor;
	/** Live runtimes + parent links for tree cancellation. */
	private readonly tree = new CancellationTree();
	/** Per-agent progress events for the SSE endpoint. */
	private readonly events = new EventBus();
	/** Sandbox root for workspace tools (undefined = no workspace tools). */
	readonly workspace: Workspace | undefined;
	private agentCounter = 0;

	constructor(options: {
		store?: AgentStore | undefined;
		accounts?: AccountRegistryEntry[];
		tools?: ToolExecutor | undefined;
		/** Sandbox root; enables the workspace tool set when provided. */
		workspace?: Workspace | undefined;
		/** Cross-process lease store (multi-worker deployments). */
		leases?: LeaseStore | undefined;
	} = {}) {
		this.accounts = new AccountRegistry();
		if (options.accounts) {
			for (const account of options.accounts) this.accounts.register(account);
		} else {
			// Seed every provider that is usable right now: a credential
			// resolves, or it serves chat anonymously. Providers that are
			// merely listable stay out — a visible-but-unauthenticated
			// provider only produces 401s and burns attempts (pi-free #530).
			for (const seed of availableSeeds()) {
				this.accounts.register({
					accountId: `${seed.providerId}:primary`,
					providerId: seed.providerId,
					credentialRef: seed.credentialRef,
					enabled: true,
					maxConcurrency: 4,
					baseUrl: seed.baseUrl,
					anonymousTier: seed.anonymousTier,
				});
			}
		}
		this.store = options.store;
		// Durable journal when a store exists — side-effect safety across
		// restarts (the tool executor consults lookup before re-running).
		this.toolExecutor = options.tools ?? new ToolExecutor({
			journal: this.store ? new PersistentToolJournal(this.store) : undefined,
		});
		this.workspace = options.workspace;
		if (!options.tools) {
			registerBuiltinTools(this.toolExecutor);
			// Workspace tools are opt-in: they need a sandbox root.
			if (this.workspace) registerWorkspaceTools(this.toolExecutor, this.workspace);
		}
		this.dispatcher = new Dispatcher({ accounts: this.accounts, leases: options.leases });
		// Logged-out accounts stay out of the pool when their chat needs a
		// key (pi-free #530): only keyless-usable providers stay enabled
		// without a credential. Cline/FastRouter list keyless but 401 on chat.
		if (!options.accounts) {
			for (const account of this.accounts.all()) {
				if (!resolveKey(account)) {
					account.enabled = account.providerId === "llm7";
				}
			}
		}
	}

	// =========================================================================
	// Spawn / status / cancel
	// =========================================================================

	spawnAgent(request: SpawnRequest, now: number = Date.now()): SpawnResult {
		// Idempotency first.
		if (request.idempotencyKey && this.store) {
			const existing = this.store.checkIdempotency(request.idempotencyKey);
			if (existing) return { agentId: existing, duplicate: true };
		}

		this.agentCounter += 1;
		const agentId = request.spec.agentId ?? `agent-${now.toString(36)}-${this.agentCounter}`;
		const spec: AgentSpec = { ...DEFAULT_SPEC, ...request.spec, agentId };

		if (this.store) {
			this.store.recordIdempotency(request.idempotencyKey ?? `auto:${agentId}`, agentId, now);
			this.store.upsertAgent({ agentId, spec, state: "queued", createdAt: now, updatedAt: now });
		}

		const runtime = this.createRuntime(spec, now);
		this.tree.register(spec.agentId, spec.parentAgentId, runtime);
		this.events.emit(agentId, "agent.queued", { parent: spec.parentAgentId ?? null });
		// Fire-and-forget with contained rejection (async job contract).
		void runtime.run().catch(() => undefined);
		return { agentId, duplicate: false };
	}

	private createRuntime(spec: AgentSpec, now: number): AgentRuntime {
		const runtime = new AgentRuntime(
			spec,
			{
				executeTurn: async (messages, opts) => {
					this.events.emit(spec.agentId, "turn.routed", { turn: opts.turnIndex });
					const result = await this.dispatcher.executeTurn(messages, opts, this.toolExecutor?.specs());
					if (this.store && result.ok) {
						this.store.recordAttempt({
							attemptId: `${opts.agentId}:${opts.turnIndex}:${result.accountId}`,
							agentId: opts.agentId,
							turnIndex: opts.turnIndex,
							accountId: result.accountId,
							modelId: result.modelId,
							sentAt: now,
							status: "committed",
							latencyMs: result.outcome.latencyMs,
						});
					}
					if (!result.ok) {
						this.events.emit(spec.agentId, "agent.failed", { turn: opts.turnIndex, reason: result.reason });
					}
					return result;
				},
			},
			{
				execute: async (agentId, turnIndex, callId, tool, argsJson, signal) => {
					const result = await this.toolExecutor.execute(agentId, turnIndex, callId, tool, argsJson, signal);
					// Counts and the tool NAME only — arguments stay out of events.
					this.events.emit(agentId, "tool.executed", { turn: turnIndex, tool });
					return result;
				},
			},
			{
				onStateChange: (state) => {
					this.events.emit(spec.agentId, state === "running" ? "agent.started" : "agent.state", { state });
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state, updatedAt: Date.now() });
					}
				},
				onTurnCommitted: (turnIndex, content) => {
					this.events.emit(spec.agentId, "turn.committed", { turn: turnIndex, chars: content.length });
					// Durable transcript: the committed assistant message survives
					// restarts so recovery can distinguish committed from lost.
					if (this.store) {
						this.store.appendTranscriptMessage(spec.agentId, turnIndex * 10, {
							role: "assistant",
							content,
						});
					}
				},
				onComplete: (content) => {
					this.events.emit(spec.agentId, "agent.completed", { chars: content.length });
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "completed", updatedAt: Date.now(), finalContent: content });
					}
					this.tree.unregister(spec.agentId);
				},
				onFail: (reason) => {
					this.events.emit(spec.agentId, "agent.failed", { reason });
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "failed", updatedAt: Date.now(), failReason: reason });
					}
					this.tree.unregister(spec.agentId);
				},
			},
		);
		return runtime;
	}

	/** Event stream access for the SSE endpoint and tests. */
	get eventBus(): EventBus {
		return this.events;
	}

	getAgent(agentId: string): (AgentRow & { transcript?: ReadonlyArray<ChatMessage> }) | undefined {
		const row = this.store?.getAgent(agentId);
		const runtime = this.tree.live().includes(agentId) ? this.runtimeFor(agentId) : undefined;
		if (row) {
			return { ...row, transcript: runtime?.getTranscript() };
		}
		if (runtime) {
			const state = runtime.getState();
			return { agentId, spec: runtime["spec"], state, createdAt: 0, updatedAt: Date.now(), transcript: runtime.getTranscript() };
		}
		return undefined;
	}

	private runtimeFor(agentId: string): AgentRuntime | undefined {
		// The tree holds live runtimes; expose via a lookup hook.
		return this.tree.lookup(agentId);
	}

	cancelAgent(agentId: string): boolean {
		const cancelled = this.tree.cancelTree(agentId);
		for (const id of cancelled) this.events.emit(id, "agent.cancelled");
		return cancelled.length > 0;
	}

	// =========================================================================
	// Capacity view
	// =========================================================================

	capacity(): CapacityView[] {
		return this.accounts.all().map((account) => {
			const circuit = this.dispatcher.circuit.get(account.accountId);
			const minuteBucket = this.dispatcher.quota
				.getAccountBuckets(account.accountId)
				.find((b) => b.scope === "account" && b.metric === "requests" && b.window === "minute");
			return {
				accountId: account.accountId,
				providerId: account.providerId,
				enabled: account.enabled,
				circuit: circuit.state,
				cooldownUntil: circuit.cooldownUntil,
				inFlight: this.dispatcher.quota.inFlightCount(account.accountId),
				remainingMinute: minuteBucket?.remaining,
				models: this.dispatcher.quota.getAccountBuckets(account.accountId).length,
			};
		});
	}

	/** Load candidate catalogs (call once at startup, refresh hourly). */
	async refreshCatalogs(): Promise<number> {
		const candidates = await this.dispatcher.loadCandidates();
		_logger.info("catalogs_loaded", { candidates: candidates.length });
		return candidates.length;
	}
}

export type { WireModel };
