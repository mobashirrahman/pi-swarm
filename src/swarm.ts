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
import { AccountRegistry, SEED_PROVIDERS, resolveKey, type AccountRegistryEntry, type WireModel } from "./catalog.ts";
import { createLogger } from "./logger.ts";
import { Dispatcher } from "./dispatcher.ts";
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
	/** Live runtimes keyed by agentId (in-flight work). */
	private readonly runtimes = new Map<string, AgentRuntime>();
	private agentCounter = 0;

	constructor(options: { store?: AgentStore | undefined; accounts?: AccountRegistryEntry[] } = {}) {
		this.accounts = new AccountRegistry();
		if (options.accounts) {
			for (const account of options.accounts) this.accounts.register(account);
		} else {
			// Seed: keyless-catalog providers, one primary account each.
			for (const seed of SEED_PROVIDERS) {
				this.accounts.register({
					accountId: `${seed.providerId}:primary`,
					providerId: seed.providerId,
					credentialRef: `${seed.providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
					enabled: true,
					maxConcurrency: 4,
					baseUrl: seed.baseUrl,
				});
			}
		}
		this.store = options.store;
		this.dispatcher = new Dispatcher({ accounts: this.accounts });
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
		this.runtimes.set(agentId, runtime);
		// Fire-and-forget with contained rejection (async job contract).
		void runtime.run().catch(() => undefined);
		return { agentId, duplicate: false };
	}

	private createRuntime(spec: AgentSpec, now: number): AgentRuntime {
		const runtime = new AgentRuntime(
			spec,
			{
				executeTurn: async (messages, opts) => {
					const result = await this.dispatcher.executeTurn(messages, opts);
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
					return result;
				},
			},
			{
				onStateChange: (state) => {
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state, updatedAt: Date.now() });
					}
				},
				onComplete: (content) => {
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "completed", updatedAt: Date.now(), finalContent: content });
					}
				},
				onFail: (reason) => {
					if (this.store) {
						const row = this.store.getAgent(spec.agentId);
						if (row) this.store.upsertAgent({ ...row, state: "failed", updatedAt: Date.now(), failReason: reason });
					}
				},
			},
		);
		return runtime;
	}

	getAgent(agentId: string): (AgentRow & { transcript?: ReadonlyArray<ChatMessage> }) | undefined {
		const row = this.store?.getAgent(agentId);
		const runtime = this.runtimes.get(agentId);
		if (row) {
			return { ...row, transcript: runtime?.getTranscript() };
		}
		const liveRuntime = this.runtimes.get(agentId);
		if (liveRuntime) {
			const state = liveRuntime.getState();
			return { agentId, spec: liveRuntime["spec"], state, createdAt: 0, updatedAt: Date.now(), transcript: liveRuntime.getTranscript() };
		}
		return undefined;
	}

	cancelAgent(agentId: string): boolean {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return false;
		runtime.cancel();
		return true;
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
