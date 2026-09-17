/**
 * Shared domain types for pi-swarm.
 *
 * The allocation unit is an ACCOUNT (provider + credential), not a provider:
 * 20 models on one provider share one rate limit. Quota lives in hierarchical
 * buckets (account → model) because some providers scope limits per model and
 * some per account — a turn is admissible only when EVERY applicable bucket
 * can reserve.
 */

// =============================================================================
// Accounts
// =============================================================================

/** A single credential against one provider. Allocation unit for quota. */
export interface ProviderAccount {
	/** Stable id, e.g. "kilo:primary". Never the raw key. */
	accountId: string;
	/** pi-free provider id, e.g. "kilo", "llm7". */
	providerId: string;
	/** Where the secret comes from: env var name or secret-manager ref. */
	credentialRef: string;
	enabled: boolean;
	/** Max concurrent in-flight requests for this account. */
	maxConcurrency: number;
}

// =============================================================================
// Quota buckets
// =============================================================================

export type QuotaMetric = "requests" | "tokens";
export type QuotaWindow = "minute" | "day";
export type BucketScope = "account" | "model";
export type BucketConfidence = "header" | "configured" | "inferred" | "unknown";

/**
 * One quota gauge. `remaining`/`limit` are undefined until first observed —
 * an unknown bucket admits ONE probation request, then locks onto whatever
 * the response headers (or configured fallback) reveal.
 */
export interface QuotaBucket {
	accountId: string;
	scope: BucketScope;
	/** Present only when scope === "model". */
	modelId?: string | undefined;
	metric: QuotaMetric;
	window: QuotaWindow;
	limit?: number | undefined;
	remaining?: number | undefined;
	/** Epoch ms when the window is believed to reset. */
	resetAt?: number | undefined;
	/** Epoch ms of the last authoritative observation. */
	observedAt: number;
	confidence: BucketConfidence;
}

/** Stable composite key for a bucket within the registry. */
export function bucketKey(
	accountId: string,
	scope: BucketScope,
	metric: QuotaMetric,
	window: QuotaWindow,
	modelId?: string,
): string {
	const modelPart = scope === "model" && modelId ? `:${modelId}` : "";
	return `${accountId}|${scope}${modelPart}|${metric}/${window}`;
}

// =============================================================================
// Candidates
// =============================================================================

/** A routable (account, model) pair. */
export interface Candidate {
	accountId: string;
	providerId: string;
	modelId: string;
	/** Human display name, used for CI-score lookup heuristics. */
	name: string;
	/** Coding Index score, 0–100; null = unscored. */
	ciScore: number | null;
	/** Advertised context window in tokens (best-effort). */
	contextWindow: number;
	/** Capabilities this model advertises. */
	capabilities: ModelCapabilities;
}

export interface ModelCapabilities {
	text: boolean;
	vision: boolean;
	tools: boolean;
}

// =============================================================================
// Health
// =============================================================================

export interface AccountCircuitState {
	accountId: string;
	/** "closed" = healthy, "open" = cooling down, "half_open" = one probe allowed. */
	state: "closed" | "open" | "half_open";
	/** Epoch ms; 0 when closed. */
	cooldownUntil: number;
	/** Consecutive failure count driving the open state. */
	consecutiveFailures: number;
}

export type FailureClass =
	| "auth" // 401 — disable account until credential changes
	| "policy" // 403 — account or model policy denial
	| "quota" // 402/429 — account or model exhausted
	| "model_gone" // 404/410 — model id no longer exists
	| "bad_request" // 400/405/406/415/422/451 — request defect, switching won't help
	| "server" // 5xx / network — transient
	| "context_overflow" // transcript too large for the model
	| "unknown";

/** Per-account response outcome counters (ported from pi-free #437 counters). */
export interface ResponseCounters {
	authFailures: number;
	policyFailures: number;
	rateLimited: number;
	serverErrors: number;
	/** Rate-limit headers present but none matched a known pair. */
	quotaHeaderDrift: number;
}

// =============================================================================
// Observability
// =============================================================================

/**
 * Wire-signature entry: header NAMES only, never values.
 * A token/value here would leak credentials into logs.
 */
export interface WireSignature {
	provider: string;
	modelId: string;
	accountId: string;
	headerNames: string[];
}
