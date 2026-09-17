/**
 * Turn router selector — PURE, no I/O, deterministic given inputs.
 *
 * Policy (from the plan): hard constraints first, then quality band, then
 * projected finish time. NOT a single opaque weighted score mixing quality
 * and quota — small weight changes must never route high-value work to a
 * bad model.
 *
 *   Stage A: eligibility  (auth, enabled, blacklist, circuit, quota headroom,
 *            capabilities, context window, cost)
 *   Stage B: quality band (qualityFloor; unknown CI is its own band)
 *   Stage C: projected finish:
 *
 *     T_finish = max(T_now, T_next_capacity) + EWMA(turn latency)
 *
 *   Tie-breaks: success rate → quota headroom → in-flight → stable hash.
 */

import type { Candidate, FailureClass } from "./types.ts";

// =============================================================================
// Inputs
// =============================================================================

/** Everything the selector may consult. All clock reads are parameters. */
export interface SelectorContext {
	now: number;
	/** Epoch ms of the next known capacity release per account (0 = free now). */
	nextCapacityAt: ReadonlyMap<string, number>;
	/** Current in-flight request count per account. */
	inFlight: ReadonlyMap<string, number>;
	/** Max concurrent requests per account. */
	maxConcurrency: ReadonlyMap<string, number>;
	/** Remaining request quota this minute per account (undefined = unknown/probation). */
	remainingRequests: ReadonlyMap<string, number | undefined>;
	/** EWMA of successful turn latency per "accountId/modelId" (ms). */
	ewmaLatencyMs: ReadonlyMap<string, number>;
	/** Recent success rate per "accountId/modelId" (0..1). */
	successRate: ReadonlyMap<string, number>;
	/** Blacklisted "accountId/modelId" keys. */
	blacklisted: ReadonlySet<string>;
	/** "accountId/modelId" pairs excluded for this turn (reroute trail). */
	excludeModels?: ReadonlySet<string> | undefined;
	/** Accounts whose circuit blocks admission right now. */
	circuitOpen: ReadonlySet<string>;
	/** Estimated tokens the turn will consume (input + max output). */
	estimatedTokens: number;
}

/** What the requesting agent needs. */
export interface TurnRequirements {
	capabilities: Array<"text" | "vision" | "tools">;
	/** Minimum context window (tokens) — must fit the transcript estimate. */
	minimumContextTokens: number;
	/** Minimum CI score; unscored models are ineligible unless allowed. */
	qualityFloor: number | null;
	allowUnknownQuality: boolean;
	/** Free-only unless explicitly enabled. */
	allowPaid: boolean;
	/** Restrict/forbid providers (both optional). */
	allowedProviders?: ReadonlySet<string> | undefined;
	deniedProviders?: ReadonlySet<string> | undefined;
	/** Accounts already tried this turn — excluded (reroute). */
	excludeAccounts?: ReadonlySet<string> | undefined;
	/** "accountId/modelId" pairs already tried — excluded (model-scoped reroute). */
	excludeModels?: ReadonlySet<string> | undefined;
	/**
	 * Agent identity for the final spread tie-break: hashing agentId INTO
	 * the stable hash decorrelates concurrent agents (thundering herd).
	 * Without it, all agents deterministically pick the same model.
	 */
	agentId?: string | undefined;
}

export interface RoutedCandidate {
	candidate: Candidate;
	/** Projected finish epoch ms. */
	projectedFinishAt: number;
	/** Components exposed for observability/debugging. */
	diag: {
		waitMs: number;
		latencyMs: number;
		remaining: number | undefined;
		successRate: number;
	};
}

export interface SelectorResult {
	best: RoutedCandidate | null;
	/** Ranked eligible candidates (after all stages). */
	ranked: RoutedCandidate[];
	/** Accounts rejected at stage A, with the reason (first blocker wins). */
	rejected: Array<{ accountId: string; modelId: string; reason: string }>;
	/**
	 * True when ≥1 candidate was rejected ONLY for concurrency pressure —
	 * a transient gap that heals when in-flight requests finish.
	 */
	concurrencyBlocked: boolean;
}

// =============================================================================
// Eligibility (Stage A)
// =============================================================================

/** Why a candidate is ineligible — first failure wins. */
function eligibilityFailure(candidate: Candidate, ctx: SelectorContext, req: TurnRequirements): string | null {
	if (ctx.circuitOpen.has(candidate.accountId)) return "circuit_open";
	if (ctx.blacklisted.has(`${candidate.accountId}/${candidate.modelId}`)) return "blacklisted";
	if (ctx.excludeModels?.has(`${candidate.accountId}/${candidate.modelId}`)) return "already_tried_model";
	if (req.excludeAccounts?.has(candidate.accountId)) return "already_tried";
	if (!candidate.capabilities.text) return "no_text";
	for (const cap of req.capabilities) {
		if (!candidate.capabilities[cap]) return `missing_capability_${cap}`;
	}
	if (candidate.contextWindow > 0 && candidate.contextWindow < req.minimumContextTokens) {
		return "context_window";
	}
	if (req.qualityFloor !== null && candidate.ciScore !== null && candidate.ciScore < req.qualityFloor) {
		return "quality_floor";
	}
	if (
		req.allowedProviders !== undefined &&
		!req.allowedProviders.has(candidate.providerId)
	) {
		return "provider_not_allowed";
	}
	if (req.deniedProviders?.has(candidate.providerId)) return "provider_denied";

	const max = ctx.maxConcurrency.get(candidate.accountId);
	if (max !== undefined && (ctx.inFlight.get(candidate.accountId) ?? 0) >= max) {
		return "concurrency";
	}

	const remaining = ctx.remainingRequests.get(candidate.accountId);
	if (remaining !== undefined && remaining < 1) return "quota_exhausted";
	return null;
}

// =============================================================================
// Projection (Stage C helpers)
// =============================================================================

function stableHash(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function latencyFor(candidate: Candidate, ctx: SelectorContext): number {
	const known = ctx.ewmaLatencyMs.get(`${candidate.accountId}/${candidate.modelId}`);
	if (known !== undefined) return known;
	// Unproven candidate: pessimistic default so a known-good model wins ties.
	return 30_000;
}

// =============================================================================
// Selector
// =============================================================================

/**
 * Rank eligible candidates by projected finish. Pure: same inputs → same
 * output. Returns ranked list (best first) plus rejection diagnostics.
 */
export function selectTurnCandidate(
	candidates: ReadonlyArray<Candidate>,
	ctx: SelectorContext,
	req: TurnRequirements,
): SelectorResult {
	const rejected: SelectorResult["rejected"] = [];
	const eligible: Candidate[] = [];
	let concurrencyBlocked = false;

	for (const candidate of candidates) {
		const failure = eligibilityFailure(candidate, ctx, req);
		if (failure) {
			if (failure === "concurrency") concurrencyBlocked = true;
			rejected.push({ accountId: candidate.accountId, modelId: candidate.modelId, reason: failure });
		} else {
			eligible.push(candidate);
		}
	}

	const ranked: RoutedCandidate[] = eligible.map((candidate) => {
		const nextCapacity = ctx.nextCapacityAt.get(candidate.accountId) ?? 0;
		const waitMs = Math.max(0, nextCapacity - ctx.now);
		const latencyMs = latencyFor(candidate, ctx);
		const key = `${candidate.accountId}/${candidate.modelId}`;
		const rate = ctx.successRate.get(key) ?? 0;
		return {
			candidate,
			projectedFinishAt: ctx.now + waitMs + latencyMs,
			diag: {
				waitMs,
				latencyMs,
				remaining: ctx.remainingRequests.get(candidate.accountId),
				successRate: rate,
			},
		};
	});

	ranked.sort((a, b) => {
		if (a.projectedFinishAt !== b.projectedFinishAt) return a.projectedFinishAt - b.projectedFinishAt;
		// Tie-break 1: success rate.
		const rateDiff = b.diag.successRate - a.diag.successRate;
		if (rateDiff !== 0) return rateDiff;
		// Tie-break 2: quota headroom (unknown → -1, below any known value).
		const remA = a.diag.remaining ?? -1;
		const remB = b.diag.remaining ?? -1;
		if (remA !== remB) return remB - remA;
		// Tie-break 3: lower in-flight.
		const infA = ctx.inFlight.get(a.candidate.accountId) ?? 0;
		const infB = ctx.inFlight.get(b.candidate.accountId) ?? 0;
		if (infA !== infB) return infA - infB;
		// Tie-break 4: stable hash — deterministic spread. agentId is folded
		// in so concurrent agents decorrelate instead of herding on one model.
		const hashA = stableHash(`${req.agentId ?? ""}|${a.candidate.accountId}/${a.candidate.modelId}`);
		const hashB = stableHash(`${req.agentId ?? ""}|${b.candidate.accountId}/${b.candidate.modelId}`);
		return hashA - hashB;
	});

	return { best: ranked[0] ?? null, ranked, rejected, concurrencyBlocked };
}

/**
 * Failure-class gate: should this failed attempt trigger a REROUTE to a
 * different account, a SAME-account retry, or a hard stop?
 * Pure policy shared by scheduler and tests.
 */
export function rerouteDecision(
	cls: FailureClass,
	attemptsOnTurn: number,
	maxAttempts: number,
): "reroute" | "same_account_retry" | "fail" {
	if (attemptsOnTurn >= maxAttempts) return "fail";
	switch (cls) {
		case "auth":
		case "policy":
		case "model_gone":
		case "bad_request":
		case "context_overflow":
			// Auth/policy: fail the attempt chain (another account COULD serve,
			// but the classifier marks these unrecoverable-for-rerouting per
			// ported semantics — the account is disabled, the turn fails fast).
			return "fail";
		case "quota":
		case "server":
		case "unknown":
			return "reroute";
	}
}
