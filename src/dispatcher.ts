/**
 * Dispatcher: the scheduler core. Owns candidate construction, quota
 * reservations, account/model health, and turn execution with reroute.
 *
 * Invariants:
 *  - Reservation precedes send; release on never-sent; commit on success.
 *  - A sent-but-failed request is charged (providers may count failures).
 *  - Circuit + blacklist strikes on classified failures only; cancellation
 *    (abort without >=500 status) is never a strike.
 *  - Success clears the model blacklist entry and records health EWMA.
 */

import { AgentRuntime, type AgentSpec } from "./agent.ts";
import { Blacklist } from "./blacklist.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { classifyAbort, classifyFailure } from "./classifier.ts";
import { createLogger } from "./logger.ts";
import { QuotaRegistry } from "./quota-registry.ts";
import { selectTurnCandidate, type SelectorContext, type TurnRequirements } from "./selector.ts";
import { streamTurn, type ChatMessage, type ToolSpec, type TurnOutcome } from "./stream.ts";
import { fetchCatalog, resolveKey, wireModelIsChat, wireModelIsFree, type AccountRegistry, type AccountRegistryEntry, type WireModel } from "./catalog.ts";
import { computeRetryBackoffMs, sleep } from "./fetch.ts";
import type { LeaseStore, TurnLease } from "./leases.ts";
import type { HeaderQuota } from "./quota-headers.ts";
import type { Candidate } from "./types.ts";

const _logger = createLogger("dispatcher");

/** Rough token estimate: ~4 chars/token, floor 1. */
export function estimateTokens(messages: ReadonlyArray<ChatMessage>): number {
	let chars = 0;
	for (const message of messages) {
		chars += message.content?.length ?? 0;
		if (message.tool_calls) {
			for (const call of message.tool_calls) {
				chars += call.function.arguments.length + call.function.name.length;
			}
		}
	}
	return Math.max(1, Math.ceil(chars / 4));
}

export interface DispatcherOptions {
	accounts: AccountRegistry;
	/** Catalog fetcher injection point (tests). */
	fetchModels?: ((account: AccountRegistryEntry) => Promise<WireModel[]>) | undefined;
	defaultMaxConcurrency?: number;
	/** Max staged output tokens for the reserve estimate. */
	defaultMaxOutputTokens?: number;
	/**
	 * Cross-process lease store. When provided, the dispatcher acquires a
	 * fenced lease before sending and validates it before committing, so
	 * several worker processes cannot overspend one account.
	 */
	leases?: LeaseStore | undefined;
	/** Lease duration; must exceed a turn's wall time. */
	leaseTtlMs?: number;
	/**
	 * Base backoff for quota (429) waits. Quota windows refill on
	 * seconds-to-minutes scales, so this is deliberately larger than the
	 * transient-error base. Configurable so tests need not wait it out.
	 */
	quotaBackoffBaseMs?: number;
	/**
	 * How long a quota (429) strike shadows a model. Quota windows refill, so
	 * this is far shorter than the session TTL for other failures.
	 */
	quotaBlacklistTtlMs?: number;
}

interface ModelHealth {
	latencyEwmaMs: number;
	samples: number;
	successes: number;
	failures: number;
}

const EWMA_ALPHA = 0.3;
const UNPROVEN_LATENCY_MS = 30_000;

export class Dispatcher {
	readonly quota: QuotaRegistry;
	readonly blacklist: Blacklist;
	readonly circuit: CircuitBreaker;
	private readonly accounts: AccountRegistry;
	private readonly fetchModels: (account: AccountRegistryEntry) => Promise<WireModel[]>;
	private readonly defaultMaxConcurrency: number;
	private readonly defaultMaxOutputTokens: number;
	private readonly leases: LeaseStore | undefined;
	private readonly leaseTtlMs: number;
	private readonly quotaBackoffBaseMs: number;
	/** "accountId/modelId" → health. */
	private readonly health = new Map<string, ModelHealth>();
	/** providerId → accounts. */
	private readonly accountsByProvider = new Map<string, AccountRegistryEntry[]>();
	/** Anonymous-session model bans: "accountId/modelId" that 401'd keyless. */
	private readonly anonModelBans = new Set<string>();
	private candidatesCache: Candidate[] | undefined;

	constructor(options: DispatcherOptions) {
		this.accounts = options.accounts;
		this.quota = new QuotaRegistry();
		this.blacklist = new Blacklist({ quotaTtlMs: options.quotaBlacklistTtlMs ?? 30_000 });
		this.circuit = new CircuitBreaker();
		this.fetchModels = options.fetchModels ?? (async (account) => {
			const result = await fetchCatalog(account);
			return result.models;
		});
		this.defaultMaxConcurrency = options.defaultMaxConcurrency ?? 4;
		this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4096;
		this.leases = options.leases;
		this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60 * 1000;
		this.quotaBackoffBaseMs = options.quotaBackoffBaseMs ?? 5_000;
		for (const account of this.accounts.all()) {
			const list = this.accountsByProvider.get(account.providerId) ?? [];
			list.push(account);
			this.accountsByProvider.set(account.providerId, list);
		}
	}

	// =========================================================================
	// Candidates
	// =========================================================================

	/** Build the routable candidate set from enabled accounts + catalogs. */
	async loadCandidates(): Promise<Candidate[]> {
		const candidates: Candidate[] = [];
		for (const account of this.accounts.enabled()) {
			let models: WireModel[];
			try {
				models = await this.fetchModels(account);
			} catch {
				continue;
			}
			// Chat-capable models only (image/video generators share the endpoint).
			const chatModels = models.filter((model) => wireModelIsChat(model));
			// Anonymous accounts: restrict to the keyless-usable tier. The tier
			// name is per-account (llm7 uses "turbo"; verified live that its
			// "pro" models 401 without a key even though the catalog lists them).
			const anonymous = !resolveKey(account);
			const anonymousTier = account.anonymousTier;
			const usable = anonymous && anonymousTier !== undefined
				? chatModels.filter((model) => model.tier === undefined || model.tier === anonymousTier)
				: chatModels;
			// Free-first: when the catalog exposes ANY zero-priced chat model,
			// restrict to those (free-only policy). Catalogs with no free chat
			// models (e.g. trial-credit gateways) keep their full list —
			// free/paid enforcement happens at selection time via allowPaid.
			const freeModels = usable.filter((model) => wireModelIsFree(model));
			const visible = freeModels.length > 0 ? freeModels : usable;
			for (const model of visible) {
				candidates.push({
					accountId: account.accountId,
					providerId: account.providerId,
					modelId: model.id,
					name: model.name ?? model.id,
					ciScore: null, // CI lookup lands with the benchmark port
					contextWindow: model.context_length ?? 0,
					capabilities: { text: true, vision: false, tools: true },
				});
			}
		}
		this.candidatesCache = candidates;
		return candidates;
	}

	private getCandidates(): Candidate[] {
		return this.candidatesCache ?? [];
	}

	// =========================================================================
	// Selector context
	// =========================================================================

	private buildContext(
		now: number,
		estimatedTokens: number,
		excludeModels?: ReadonlySet<string>,
	): SelectorContext {
		const nextCapacityAt = new Map<string, number>();
		const inFlight = new Map<string, number>();
		const maxConcurrency = new Map<string, number>();
		const remainingRequests = new Map<string, number | undefined>();
		const circuitOpen = new Set<string>();
		const blacklisted = new Set<string>();

		for (const account of this.accounts.enabled()) {
			inFlight.set(account.accountId, this.quota.inFlightCount(account.accountId));
			maxConcurrency.set(account.accountId, account.maxConcurrency || this.defaultMaxConcurrency);

			const circuit = this.circuit.get(account.accountId);
			if (!this.circuit.canAdmit(account.accountId, now)) {
				circuitOpen.add(account.accountId);
				nextCapacityAt.set(account.accountId, Math.max(nextCapacityAt.get(account.accountId) ?? 0, circuit.cooldownUntil));
			}

			// Minute request bucket drives remaining; unknown → undefined.
			const minuteBucket = this.quota
				.getAccountBuckets(account.accountId)
				.find((b) => b.scope === "account" && b.metric === "requests" && b.window === "minute");
			remainingRequests.set(account.accountId, minuteBucket?.remaining);

			const earliest = this.quota
				.getAccountBuckets(account.accountId)
				.reduce<number | undefined>((acc, bucket) => {
					if (bucket.remaining === undefined) return acc;
					if (bucket.remaining < 1 && bucket.resetAt && (acc === undefined || bucket.resetAt < acc)) {
						return bucket.resetAt;
					}
					return acc;
				}, undefined);
			if (earliest !== undefined) {
				nextCapacityAt.set(account.accountId, Math.max(nextCapacityAt.get(account.accountId) ?? 0, earliest));
			}
		}

		// Only entries still inside their (class-aware) TTL window block selection.
		// Copying the raw snapshot made an EXPIRED quota strike permanent — the
		// model could never be retried and the turn spun until its deadline
		// (measured: a single 429 stalled a turn for 90s+).
		for (const key of this.blacklist.snapshot().keys()) {
			if (this.blacklist.isBlacklisted(key, now)) blacklisted.add(key);
		}
		if (excludeModels) for (const key of excludeModels) blacklisted.add(key);
		for (const key of this.anonModelBans) blacklisted.add(key);

		void estimatedTokens;
		return {
			now,
			nextCapacityAt,
			inFlight,
			maxConcurrency,
			remainingRequests,
			ewmaLatencyMs: this.latencyMap(),
			successRate: this.successRateMap(),
			blacklisted,
			circuitOpen,
			estimatedTokens,
		};
	}

	/** Wall-clock deadline for one executeTurn call (set at entry). */
	private turnDeadline = 0;

	/**
	 * Is the empty selection caused by something that heals on its own?
	 * Circuit cooldowns and soft-ban TTLs expire; hard bans (max strikes)
	 * and disabled accounts do not.
	 */
	private hasTransientGap(ctx: SelectorContext): boolean {
		// Any account in open/half_open circuit state will re-admit later.
		for (const accountId of ctx.circuitOpen) {
			const circuit = this.circuit.get(accountId);
			if (circuit.state === "half_open") return true;
			if (circuit.state === "open" && circuit.cooldownUntil > ctx.now) return true;
		}
		// Soft-banned (not hard-banned) keys expire at window end.
		for (const key of ctx.blacklisted) {
			const entry = this.blacklist.snapshot().get(key);
			if (entry && entry.count < 3) return true; // soft ban heals at TTL
		}
		return false;
	}

	/**
	 * Wall-clock bound for capacity waits: maxAttempts × 4s of waiting is
	 * the cap (the agent's own maxWallTimeMs governs the runtime loop).
	 */
	private deadlineHint(_opts: { agentId: string; turnIndex: number }): number {
		return Date.now() + 4_000 * 2;
	}

	private latencyMap(): Map<string, number> {
		const map = new Map<string, number>();
		for (const [key, health] of this.health) {
			if (health.samples > 0) map.set(key, health.latencyEwmaMs);
		}
		return map;
	}

	private successRateMap(): Map<string, number> {
		const map = new Map<string, number>();
		for (const [key, health] of this.health) {
			const total = health.successes + health.failures;
			map.set(key, total === 0 ? 0 : health.successes / total);
		}
		return map;
	}

	// =========================================================================
	// Turn execution
	// =========================================================================

	/**
	 * Execute one model turn: select → reserve → send → reconcile, with
	 * classified reroute on retryable failure. Rejects with a terminal
	 * reason when every attempt is exhausted.
	 */
	async executeTurn(
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
		tools?: ReadonlyArray<ToolSpec>,
	): Promise<{ ok: true; outcome: Extract<TurnOutcome, { ok: true }>; accountId: string; modelId: string } | { ok: false; reason: string }> {
		const excludeAccounts = new Set<string>();
		/** "accountId/modelId" pairs excluded this turn (model-scoped reroute). */
		const excludeModels = new Set<string>();
		const estimatedTokens = estimateTokens(messages) + this.defaultMaxOutputTokens;
		this.turnDeadline = Date.now() + 240_000; // transient-gap wait bound

		let attempt = 1;
		/**
		 * Quota (429) waits do NOT consume the provider-attempt budget: a rate
		 * limit is a WAIT, not a failed attempt. Without this a 429 storm kills
		 * the turn at `maxAttempts` sends (~60s measured) even though the
		 * window would refill — the opposite of the product goal. Waits remain
		 * bounded by the turn deadline and a hard cap.
		 */
		let quotaWaits = 0;
		const MAX_QUOTA_WAITS = 20;
		while (attempt <= opts.maxAttempts + quotaWaits && quotaWaits <= MAX_QUOTA_WAITS) {
			if (opts.signal.aborted) return { ok: false, reason: "aborted" };
			const now = Date.now();
			const ctx = this.buildContext(now, estimatedTokens, excludeModels);
			const requirements: TurnRequirements = {
				capabilities: opts.capabilities,
				minimumContextTokens: estimatedTokens,
				qualityFloor: opts.qualityFloor,
				allowUnknownQuality: opts.allowUnknownQuality,
				allowPaid: false,
				excludeAccounts,
				excludeModels,
				agentId: opts.agentId,
			};
			const selection = selectTurnCandidate(this.getCandidates(), ctx, requirements);
			if (!selection.best) {
				// Nothing eligible RIGHT NOW. Distinguish terminal exhaustion
				// (every candidate hard-banned/disabled) from transient gaps
				// (circuit cooldown, quota window, CONCURRENCY). Transient:
				// wait and re-select WITHOUT burning an attempt — backpressure
				// is the exhaustion contract (acceptance #3).
				const transientGap = selection.concurrencyBlocked || this.hasTransientGap(ctx);
				if (transientGap && Date.now() < this.turnDeadline) {
					await sleep(2_000);
					continue; // does NOT consume an attempt
				}
				return { ok: false, reason: "no_eligible_candidate" };
			}
			const { candidate } = selection.best;
			const account = this.accounts.get(candidate.accountId);
			if (!account) return { ok: false, reason: "account_missing" };

			const reservation = this.quota.tryReserve(
				{ accountId: candidate.accountId, modelId: candidate.modelId, estimatedTokens },
				now,
				account.maxConcurrency || this.defaultMaxConcurrency,
			);
			if (!reservation.ok || !reservation.reservation) {
				// Gated by capacity (concurrency cap / quota window): WAIT for
				// the predicted release instead of failing the turn. Does not
				// consume an attempt — the request was never sent.
				const blockKey = reservation.blockedBy ?? "";
				if (blockKey.endsWith("concurrency") && Date.now() < this.turnDeadline) {
					await sleep(2_000);
					continue; // capacity returns on its own; keep candidate eligible
				}
				excludeAccounts.add(candidate.accountId);
				continue;
			}
			const reservationId = reservation.reservation.id;
			this.quota.markSent(reservationId);

			// Cross-process gate: a fenced lease admits this turn only when the
			// ACCOUNT has free capacity across every worker process. Without a
			// lease store the in-process ledger is the only gate (single-process
			// mode). A refused lease means another process holds the capacity —
			// wait rather than fail (backpressure, acceptance #3).
			const lease = this.leases?.acquire({
				accountId: candidate.accountId,
				agentId: opts.agentId,
				turnIndex: opts.turnIndex,
				maxConcurrency: account.maxConcurrency || this.defaultMaxConcurrency,
				ttlMs: this.leaseTtlMs,
			}) ?? null;
			if (this.leases && lease === null) {
				this.quota.release(reservationId);
				if (Date.now() < this.turnDeadline) {
					await sleep(2_000);
					continue; // does NOT consume an attempt
				}
				excludeAccounts.add(candidate.accountId);
				continue;
			}

			attempt += 1; // a SENT request consumes the attempt budget

			const outcome = await streamTurn({
				baseUrl: account.baseUrl,
				modelId: candidate.modelId,
				apiKey: resolveKey(account),
				messages,
				tools,
				signal: opts.signal,
			});

			// Reconcile quota observations from headers (authoritative).
			this.applyQuotaObservation(candidate.accountId, outcome.quota, outcome.ok ? outcome.usage?.totalTokens : undefined);

			if (outcome.ok) {
				// Fence check: if another worker took this account's capacity
				// while we streamed (our lease expired and was re-issued), the
				// work is stale — do not commit it against someone else's slot.
				if (this.leases && lease && !this.leases.validate(lease)) {
					this.quota.release(reservationId);
					this.leases.release(lease.leaseId);
					_logger.info("stale_lease_rejected", {
						agentId: opts.agentId,
						account: candidate.accountId,
						token: lease.fencingToken,
					});
					excludeAccounts.add(candidate.accountId);
					continue;
				}
				// Model-defect guard: a 200 with neither content nor tool calls
				// is not an answer. Reasoning-only models (llm7's GLM returns
				// empty `content` with the text in `reasoning`) land here, and
				// committing "" would silently end the agent with nothing.
				// Treat it as a retryable model defect: strike THIS model and
				// reroute — a different model may answer properly.
				if (outcome.content.trim().length === 0 && outcome.toolCalls.length === 0) {
					this.quota.commit(reservationId, outcome.usage?.totalTokens ?? 0);
					this.releaseLease(lease);
					this.blacklist.recordFailure(`${candidate.accountId}/${candidate.modelId}`, "empty_response", Date.now());
					excludeModels.add(`${candidate.accountId}/${candidate.modelId}`);
					this.recordHealth(candidate, outcome.latencyMs, false);
					_logger.info("empty_response_reroute", {
						agentId: opts.agentId,
						turn: opts.turnIndex,
						account: candidate.accountId,
						model: candidate.modelId,
						attempt,
					});
					await sleep(computeRetryBackoffMs(attempt - 1, 1_000));
					continue;
				}
				this.quota.commit(reservationId, outcome.usage?.totalTokens ?? 0);
				this.releaseLease(lease);
				this.circuit.recordSuccess(candidate.accountId);
				this.blacklist.clear(`${candidate.accountId}/${candidate.modelId}`);
				this.recordHealth(candidate, outcome.latencyMs, true);
				return { ok: true, outcome, accountId: candidate.accountId, modelId: candidate.modelId };
			}

			// --- Failure path: charge the sent reservation, classify, decide.
			this.quota.commit(reservationId, estimatedTokens);
			this.releaseLease(lease);
			this.recordHealth(candidate, outcome.latencyMs, false);

			const abortedWithServerError = outcome.errorMessage === "aborted"
				? classifyAbort(outcome.status) !== null
				: false;

			if (outcome.errorMessage === "aborted" && !abortedWithServerError) {
				// User cancellation — never a strike, never a reroute.
				return { ok: false, reason: "aborted" };
			}

			const { kind, cls } = classifyFailure(outcome.status, outcome.errorMessage === "aborted" ? "server error" : outcome.errorMessage);
			_logger.info("turn_attempt_failed", {
				agentId: opts.agentId,
				turn: opts.turnIndex,
				account: candidate.accountId,
				model: candidate.modelId,
				status: outcome.status ?? null,
				cls,
				attempt,
			});

			if (kind === "recoverable" || kind === "unknown") {
				// Reroute semantics: the failure is charged to the MODEL first.
				// llm7 (verified live) scopes quota per model — a 429 on codestral
				// while GLM serves proves account-wide strikes are wrong here.
				// The ACCOUNT circuit only opens on model-agnostic signals
				// (quota headers, Retry-After, or repeated failures across
				// DIFFERENT models of the same account).
				this.blacklist.recordFailure(`${candidate.accountId}/${candidate.modelId}`, cls, Date.now());
				// NOTE: deliberately NOT added to excludeModels. excludeModels is
				// a permanent per-turn exclusion, which made a 429'd model
				// unretryable for the whole turn even after its quota window
				// refilled — the turn then spun on transient-gap waits until the
				// deadline (measured: one 429 stalled a turn for 90s+). The
				// blacklist's TTL is the correct gate: quota strikes expire.
				const perModelStrikes = this.blacklist.snapshot().get(`${candidate.accountId}/${candidate.modelId}`)?.count ?? 0;
				let accountDistinctFailures = 0;
				for (const key of this.blacklist.snapshot().keys()) {
					if (key.startsWith(`${candidate.accountId}/`)) accountDistinctFailures += 1;
				}
				// ≥2 DISTINCT failing models on one account = account-level pressure.
				if (outcome.quota.retryAfterMs !== undefined || accountDistinctFailures >= 2 || perModelStrikes >= 2) {
					this.circuit.recordFailure(candidate.accountId, Date.now(), outcome.quota.retryAfterMs);
				}
				// Backpressure, not hammering: brief cooldown before the next
				// attempt. Quota (429) waits LONGER than transient errors —
				// llm7's anonymous window refills on ~15s scales (measured), so
				// 1s-base jitter just burns attempts against a closed window.
				const quotaClass = cls === "quota";
				if (quotaClass) quotaWaits += 1; // a wait, not a failed attempt
				const waitMs = outcome.quota.retryAfterMs
					?? computeRetryBackoffMs(attempt - 1, quotaClass ? this.quotaBackoffBaseMs : 1_000, { capMs: quotaClass ? 15_000 : 10_000 });
				if (opts.signal.aborted) return { ok: false, reason: "aborted" };
				await sleep(Math.min(waitMs, quotaClass ? 15_000 : 10_000));
				continue;
			}

			// Unrecoverable for the MODEL, but not necessarily for the account:
		// gateways scope entitlements per model (verified live: llm7 401s on
		// some turbo models while GLM serves; bai 403s on one model while
		// others answer). So: strike the MODEL, exclude it, and reroute.
		// The ACCOUNT only dies when ≥2 distinct models fail this way — that
		// is a credential problem, not a model entitlement.
		if (cls === "auth" || cls === "policy") {
			const modelKey = `${candidate.accountId}/${candidate.modelId}`;
			this.blacklist.recordFailure(modelKey, cls, Date.now());
			if (cls === "auth" && !resolveKey(account)) this.anonModelBans.add(modelKey);
			excludeModels.add(modelKey);

			let distinctCredentialFailures = 0;
			for (const key of this.blacklist.snapshot().keys()) {
				if (!key.startsWith(`${candidate.accountId}/`)) continue;
				const entry = this.blacklist.snapshot().get(key);
				if (entry?.reasons.some((reason) => reason === "auth" || reason === "policy")) distinctCredentialFailures += 1;
			}
			if (distinctCredentialFailures >= 2) {
				// Multiple models rejected: the credential itself is bad.
				this.circuit.openUntil(candidate.accountId, Number.MAX_SAFE_INTEGER, Date.now());
				excludeAccounts.add(candidate.accountId);
				_logger.info("account_disabled_credentials", {
					agentId: opts.agentId,
					account: candidate.accountId,
					distinctModels: distinctCredentialFailures,
				});
			}
			_logger.info("credential_scoped_reroute", {
				agentId: opts.agentId,
				account: candidate.accountId,
				model: candidate.modelId,
				cls,
				attempt,
			});
			await sleep(computeRetryBackoffMs(attempt - 1, 500));
			continue; // try another model (or another account)
		}
			if (cls === "bad_request" && tools && tools.length > 0) {
				// A 400 on a TOOL-BEARING request usually means this model does
				// not accept the tool payload (observed live: mistral-Nemo via
				// llm7 400s where GLM executes tools fine). That is a model
				// capability limit, not a malformed request — reroute instead of
				// failing the turn. If every candidate 400s, the attempts
				// exhaust and the turn still fails, so a genuinely broken
				// request is not masked.
				this.blacklist.recordFailure(`${candidate.accountId}/${candidate.modelId}`, "no_tool_support", Date.now());
				excludeModels.add(`${candidate.accountId}/${candidate.modelId}`);
				_logger.info("tool_unsupported_reroute", {
					agentId: opts.agentId,
					account: candidate.accountId,
					model: candidate.modelId,
					attempt,
				});
				await sleep(computeRetryBackoffMs(attempt - 1, 500));
				continue;
			}
			if (cls === "model_gone") {
				this.blacklist.recordFailure(`${candidate.accountId}/${candidate.modelId}`, cls, Date.now());
			}
			return { ok: false, reason: cls };
		}

		return { ok: false, reason: "attempts_exhausted" };
	}

	/** Release a lease if one was taken (no-op in single-process mode). */
	private releaseLease(lease: TurnLease | null): void {
		if (this.leases && lease) this.leases.release(lease.leaseId);
	}

	/** Current live leases for an account (diagnostics for /v1/capacity). */
	activeLeases(accountId: string): TurnLease[] {
		return this.leases?.activeFor(accountId) ?? [];
	}

	private applyQuotaObservation(
		accountId: string,
		quota: { quotas: HeaderQuota[]; drift: boolean; retryAfterMs?: number },
		_actualTokens: number | undefined,
	): void {
		if (quota.drift) {
			this.quota.recordOutcome(accountId, 0, true);
		}
		for (const observed of quota.quotas) {
			this.quota.observe(accountId, observed.metric, observed.window, observed.remaining, observed.limit, {
				resetAt: observed.resetAt,
			});
		}
	}

	private recordHealth(candidate: Candidate, latencyMs: number, success: boolean): void {
		const key = `${candidate.accountId}/${candidate.modelId}`;
		let health = this.health.get(key);
		if (!health) {
			health = { latencyEwmaMs: UNPROVEN_LATENCY_MS, samples: 0, successes: 0, failures: 0 };
			this.health.set(key, health);
		}
		if (success) {
			health.successes += 1;
			health.latencyEwmaMs = health.samples === 0
				? latencyMs
				: EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * health.latencyEwmaMs;
			health.samples += 1;
		} else {
			health.failures += 1;
		}
	}
}

// Re-export for the API layer.
export { AgentRuntime, type AgentSpec };
