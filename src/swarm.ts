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
import { candidateQuality } from "./selector.ts";
import { createLogger } from "./logger.ts";
import type { QualityMetric, TierHint } from "./types.ts";
import { Dispatcher } from "./dispatcher.ts";
import { ToolExecutor, registerBuiltinTools, registerWorkspaceTools } from "./tools.ts";
import { CancellationTree } from "./cancellation.ts";
import { PersistentToolJournal } from "./tool-journal.ts";
import { EventBus } from "./events.ts";
import { TelemetryStore } from "./telemetry.ts";
import { benchmarkTableSize, fetchOpenRouterScores } from "./benchmarks.ts";
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

export const MAX_PLAN_CHILDREN = 10;

export interface PlanSubtask {
	task: string;
	system?: string | undefined;
	capabilities?: AgentSpec["capabilities"];
	tierHint?: TierHint;
	qualityMetric?: QualityMetric;
	qualityFloor?: number | null;
	allowUnknownQuality?: boolean;
	maxTurns?: number;
	maxWallTimeMs?: number;
	maxProviderAttemptsPerTurn?: number;
	idempotencyKey?: string | undefined;
}

export interface PlanRequest {
	goal?: string | undefined;
	subtasks: PlanSubtask[];
	defaults?: Omit<PlanSubtask, "task" | "idempotencyKey">;
	idempotencyKey?: string | undefined;
}

export interface PlanSpawnResult {
	planId: string;
	childIds: string[];
	/** True when an existing plan satisfied the idempotency key. */
	duplicate: boolean;
}

export interface PlanChildResult {
	agentId: string;
	state: string;
	finalContent?: string | undefined;
	failReason?: string | undefined;
}

export interface PlanGatherResult {
	planId: string;
	state: "completed" | "failed" | "running";
	timedOut?: boolean | undefined;
	children: PlanChildResult[];
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
	tierHint: "frontier",
	qualityMetric: "codingIndex",
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
	private readonly plans = new Map<string, string[]>();
	private planCounter = 0;
	private readonly terminalAgents = new Map<string, { state: AgentState; finalContent?: string | undefined; failReason?: string | undefined }>();
	/** Per-agent progress events for the SSE endpoint. */
	private readonly events = new EventBus();
	/** Sandbox root for workspace tools (undefined = no workspace tools). */
	readonly workspace: Workspace | undefined;
	/** Persisted internal performance benchmark (TTFT, tokens/sec, latency). */
	readonly telemetry: TelemetryStore | undefined;
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
					category: seed.category,
				});
			}
		}
		this.store = options.store;
		// Internal performance benchmark, persisted alongside agents so it is
		// shared across worker processes and survives restarts.
		this.telemetry = this.store ? new TelemetryStore(this.store.database) : undefined;
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
		this.dispatcher = new Dispatcher({ accounts: this.accounts, leases: options.leases, telemetry: this.telemetry });
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

		if (spec.parentAgentId) {
			const parentLive = this.tree.live().includes(spec.parentAgentId);
			const parentKnown = parentLive || this.plans.has(spec.parentAgentId) || this.store?.getAgent(spec.parentAgentId) !== undefined;
			if (!parentKnown) {
				// Dangling parent link: the child would be unreapable by
				// parent-cancel. Allow (back-compat) but say so loudly.
				_logger.warn("spawn_unknown_parent", { agentId, parent: spec.parentAgentId });
			}
		}

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
					// Advertise tools ONLY when the agent asked for them. Sending
					// them unconditionally made chatty models call a tool for
					// trivial prompts, burning turns until maxTurns (observed
					// live: "what is 8*8" failed with max_turns_exceeded after
					// two tool calls). A text-only agent should just answer.
					const tools = spec.capabilities.includes("tools") ? this.toolExecutor?.specs() : undefined;
					const result = await this.dispatcher.executeTurn(messages, opts, tools);
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
						// Aborts are cancellation, not failure: the runtime
						// reports its own cancelled transition. Emitting
						// agent.failed here produced a spurious failure event
						// on every cancelled agent (observed live).
						if (result.reason !== "aborted") {
							this.events.emit(spec.agentId, "agent.failed", { turn: opts.turnIndex, reason: result.reason });
						}
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
				onReroute: (turnIndex, from, to, reason) => {
					this.events.emit(spec.agentId, "turn.rerouted", { turn: turnIndex, from, to, reason });
				},
				onCancel: () => {
					this.events.emit(spec.agentId, "agent.cancelled");
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "cancelled", updatedAt: Date.now() });
					}
					this.rememberTerminal(spec.agentId, { state: "cancelled" });
					this.tree.unregister(spec.agentId);
				},
				onComplete: (content) => {
					this.events.emit(spec.agentId, "agent.completed", { chars: content.length });
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "completed", updatedAt: Date.now(), finalContent: content });
					}
					this.rememberTerminal(spec.agentId, { state: "completed", finalContent: content });
					this.tree.unregister(spec.agentId);
				},
				onFail: (reason) => {
					this.events.emit(spec.agentId, "agent.failed", { reason });
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "failed", updatedAt: Date.now(), failReason: reason });
					}
					this.rememberTerminal(spec.agentId, { state: "failed", failReason: reason });
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
		const terminal = this.terminalAgents.get(agentId);
		if (terminal) {
			return { agentId, spec: { task: "", maxTurns: 0, maxWallTimeMs: 0, maxProviderAttemptsPerTurn: 0, capabilities: ["text"], qualityFloor: null, allowUnknownQuality: true, agentId }, state: terminal.state, createdAt: 0, updatedAt: Date.now(), finalContent: terminal.finalContent, failReason: terminal.failReason };
		}
		return undefined;
	}

	private rememberTerminal(agentId: string, terminal: { state: AgentState; finalContent?: string | undefined; failReason?: string | undefined }): void {
		this.terminalAgents.set(agentId, terminal);
		if (this.terminalAgents.size > 1000) {
			const oldest = this.terminalAgents.keys().next().value;
			if (oldest !== undefined) this.terminalAgents.delete(oldest);
		}
	}

	private runtimeFor(agentId: string): AgentRuntime | undefined {
		// The tree holds live runtimes; expose via a lookup hook.
		return this.tree.lookup(agentId);
	}

	cancelAgent(agentId: string): boolean {
		const cancelled = this.tree.cancelTree(agentId);
		return cancelled.length > 0;
	}

	spawnPlan(request: PlanRequest, now: number = Date.now()): PlanSpawnResult {
		if (request.subtasks.length < 1 || request.subtasks.length > MAX_PLAN_CHILDREN) {
			throw new Error(`plan needs 1..${MAX_PLAN_CHILDREN} subtasks, got ${request.subtasks.length}`);
		}
		if (request.idempotencyKey && this.store) {
			const existing = this.store.checkIdempotency(`plan:${request.idempotencyKey}`);
			if (existing) return { planId: existing, childIds: this.planChildren(existing), duplicate: true };
		}

		this.planCounter += 1;
		const planId = `plan-${now.toString(36)}-${this.planCounter}`;
		this.plans.set(planId, []);
		const childIds: string[] = [];
		for (let index = 0; index < request.subtasks.length; index++) {
			const subtask = request.subtasks[index] as PlanSubtask;
			const { idempotencyKey, ...overrides } = subtask;
			const merged: Record<string, unknown> = { ...request.defaults, ...overrides };
			for (const key of Object.keys(merged)) {
				if (merged[key] === undefined) delete merged[key];
			}
			const spawned = this.spawnAgent(
				{
					spec: {
						...merged,
						task: request.goal !== undefined ? `${request.goal}\n\nSubtask ${index + 1}/${request.subtasks.length}: ${subtask.task}` : subtask.task,
						parentAgentId: planId,
					} as Omit<AgentSpec, "agentId">,
					idempotencyKey,
				},
				now,
			);
			childIds.push(spawned.agentId);
		}
		this.plans.set(planId, childIds);
		if (this.store && request.idempotencyKey) {
			this.store.recordIdempotency(`plan:${request.idempotencyKey}`, planId, now);
		}
		this.events.emit(planId, "plan.spawned", { children: childIds.length });
		return { planId, childIds, duplicate: false };
	}

	planChildren(planId: string): string[] {
		const indexed = this.plans.get(planId);
		if (indexed) return [...indexed];
		if (!this.store) return [];
		return this.store.listAgents().filter((row) => row.spec.parentAgentId === planId).map((row) => row.agentId);
	}

	async gatherPlan(planId: string, timeoutMs = 20_000): Promise<PlanGatherResult> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const children = this.planChildren(planId).map((agentId) => {
				const agent = this.getAgent(agentId);
				return {
					agentId,
					state: agent?.state ?? "unknown",
					...(agent?.finalContent !== undefined ? { finalContent: agent.finalContent } : {}),
					...(agent?.failReason !== undefined ? { failReason: agent.failReason } : {}),
				};
			});
			const settled = children.filter((child) => child.state === "completed" || child.state === "failed" || child.state === "cancelled");
			if (settled.length === children.length && children.length > 0) {
				const failed = settled.filter((child) => child.state !== "completed").length;
				this.events.emit(planId, failed === 0 ? "plan.completed" : "plan.failed", { children: children.length, failed });
				return { planId, state: failed === 0 ? "completed" : "failed", children };
			}
			if (Date.now() >= deadline) return { planId, state: "running", timedOut: true, children };
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	/**
	 * Administrative capacity reset: close circuits and clear model bans for
	 * one account (or all). Recovers the pool after a credential rotation or
	 * a false-positive trip without restarting the process.
	 */
	resetCapacity(accountId?: string): { reset: string[]; clearedBans: number } {
		const ids = accountId ? [accountId] : this.accounts.all().map((account) => account.accountId);
		let clearedBans = 0;
		for (const id of ids) clearedBans += this.dispatcher.resetAccount(id).clearedBans;
		_logger.info("capacity_reset", { accounts: ids, clearedBans });
		return { reset: ids, clearedBans };
	}

	// =========================================================================
	// Capacity view
	// =========================================================================

	capacity(): CapacityView[] {
		// Candidate counts (routable models), not quota-bucket counts — the
		// bucket count read as "models=0" and made a healthy pool look empty.
		const candidates = this.dispatcher.candidateCounts();
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
				models: candidates.get(account.accountId) ?? 0,
			};
		});
	}

	/** Re-resolve refresh interval from the environment (ms). */
	static refreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
		const raw = Number(env["PI_SWARM_REFRESH_MS"] ?? 3_600_000);
		return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
	}

	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private refreshRunning = false;

	/** Periodically re-fetch scores + catalogs; returns a stop function. Idempotent. */
	startAutoRefresh(intervalMs: number = SwarmService.refreshIntervalMs()): () => void {
		if (this.refreshTimer !== undefined) return () => this.stopAutoRefresh();
		this.refreshTimer = setInterval(() => {
			if (this.refreshRunning) return;
			this.refreshRunning = true;
			this.refreshCatalogs()
				.catch(() => undefined)
				.finally(() => {
					this.refreshRunning = false;
				});
		}, intervalMs);
		this.refreshTimer.unref?.();
		return () => this.stopAutoRefresh();
	}

	stopAutoRefresh(): void {
		if (this.refreshTimer !== undefined) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	/** Load candidate catalogs (call once at startup, refresh hourly). */
	async refreshCatalogs(): Promise<number> {
		// Intelligence scores first, so candidates are scored as they load.
		const scores = await fetchOpenRouterScores();
		if (scores.installed > 0) {
			_logger.info("intelligence_scores_ready", { live: scores.installed, vendored: benchmarkTableSize() });
		}
		const candidates = await this.dispatcher.loadCandidates();
		const scored = candidates.filter((candidate) => candidate.ciScore !== null).length;
		_logger.info("catalogs_loaded", { candidates: candidates.length, scored });
		return candidates.length;
	}

	/**
	 * The routing view: every candidate with the signals that decide its fate.
	 * This is what "which provider gets invoked" actually depends on.
	 */
	routingView(options: { limit?: number } = {}): Array<{
		accountId: string;
		modelId: string;
		quality: number | null;
		latencyMs: number | null;
		ttftMs: number | null;
		tokensPerSecond: number | null;
		successRate: number | null;
		samples: number;
		inFlight: number;
		circuit: string;
	}> {
		const candidates = this.dispatcher.candidates();
		const rows = candidates.map((candidate) => {
			const telemetry = this.telemetry?.get(candidate.accountId, candidate.modelId);
			const total = (telemetry?.samples ?? 0) + (telemetry?.failures ?? 0);
			return {
				accountId: candidate.accountId,
				modelId: candidate.modelId,
				quality: candidateQuality(candidate),
				latencyMs: telemetry?.latencyMs ?? null,
				ttftMs: telemetry?.ttftMs ?? null,
				tokensPerSecond: telemetry?.tokensPerSecond ?? null,
				successRate: total > 0 ? (telemetry?.samples ?? 0) / total : null,
				samples: total,
				inFlight: this.dispatcher.quota.inFlightCount(candidate.accountId),
				circuit: this.dispatcher.circuit.get(candidate.accountId).state,
			};
		});
		// Best first: scored models by quality, then measured speed.
		rows.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1) || (b.tokensPerSecond ?? -1) - (a.tokensPerSecond ?? -1));
		return options.limit !== undefined ? rows.slice(0, options.limit) : rows;
	}
}

export type { WireModel };
export type { TierHint, QualityMetric };
