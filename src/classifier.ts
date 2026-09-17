/**
 * Failure classifier — ported from pi-free lib/auto-fallback/classifier.ts.
 *
 * Complementary to same-model retry logic: we decide whether ANOTHER
 * account/model can serve the turn. Quota errors (402/429) are therefore
 * recoverable-by-rerouting even though same-model retry cannot fix them.
 * Auth/shape errors are unrecoverable by rerouting — switching only burns
 * candidates.
 */

import type { FailureClass } from "./types.ts";

export type FailureKind = "recoverable" | "unrecoverable" | "unknown";

/** HTTP statuses where a DIFFERENT account/model may succeed. */
export const RECOVERABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
	402, // Payment Required — quota used up on free tiers
	408, // Request Timeout
	409, // Conflict — server-side state, may be transient
	425, // Too Early
	429, // Too Many Requests — explicit rate limit
	500, 502, 503, 504, 507, // generic + storage transients
	521, 522, 523, 524, 525, 526, 527, // Cloudflare
	529, // Anthropic overloaded
]);

/** HTTP statuses where switching account/model hits the same wall. */
export const UNRECOVERABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
	400, // Bad Request — request shape wrong
	401, // Unauthorized — credential problem
	403, // Forbidden — policy denial
	404, // Not Found — model id gone
	405, 406, 410, 415, 418, 422, 451,
]);

/** Map an HTTP status to a coarse class for circuit/blacklist decisions. */
export function classifyStatus(status: number): { kind: FailureKind; cls: FailureClass } {
	if (status === 401) return { kind: "unrecoverable", cls: "auth" };
	if (status === 403 || status === 451) return { kind: "unrecoverable", cls: "policy" };
	if (status === 402 || status === 429) return { kind: "recoverable", cls: "quota" };
	if (status === 404 || status === 410) return { kind: "unrecoverable", cls: "model_gone" };
	if (RECOVERABLE_HTTP_STATUSES.has(status)) return { kind: "recoverable", cls: "server" };
	if (UNRECOVERABLE_HTTP_STATUSES.has(status)) return { kind: "unrecoverable", cls: "bad_request" };
	// Unrecognized — treat as recoverable so a real outage is not hidden
	// behind "we don't recognize this status" (pi-free precedent).
	return { kind: "unknown", cls: "unknown" };
}

/** Errors where a switch would hit the same wall. */
const FATAL_ERROR_PATTERN =
	/(?:invalid[_ -]?api[_ -]?key|invalid[_ -]?request|context[_ -]?length[_ -]?exceeded|context[_ -]?window|model[_ -]?not[_ -]?found|permission[_ -]?denied|unauthorized|forbidden)/i;

/** Provider-limit text patterns: recoverable by rerouting (not same-model). */
const PROVIDER_LIMIT_ERROR_PATTERN =
	/(?:usage\s*limit\s*error|monthly\s*usage\s*limit\s*reached|available\s*balance|insufficient[_\s-]?quota|out\s+of\s+budget|quota\s+exceeded|billing)/i;

/** Transient network/server text patterns. */
const TRANSIENT_ERROR_PATTERN =
	/(?:overloaded|rate[\s-]?limit|too\s+many\s+requests|429|500|502|503|504|524|service[\s-]?unavailable|server[\s-]?error|internal[\s-]?error|fetch\s+failed|enotfound|eai_again|socket\s+hang\s+up|timed?\s*out|timeout|premature\s+close|stream\s+ended\s+before)/i;

/**
 * Classify an error message string. Status-free path (network errors,
 * SDK-thrown messages). Returns null when the message is not conclusive.
 */
export function classifyErrorMessage(errorMessage: string | undefined): FailureKind | null {
	if (!errorMessage) return null;
	if (PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return "recoverable";
	if (FATAL_ERROR_PATTERN.test(errorMessage)) return "unrecoverable";
	if (TRANSIENT_ERROR_PATTERN.test(errorMessage)) return "recoverable";
	return null;
}

/**
 * Combined classification from status + message. Status wins when known;
 * message patterns fill the gap for network-level failures.
 */
export function classifyFailure(
	status: number | undefined,
	errorMessage: string | undefined,
): { kind: FailureKind; cls: FailureClass } {
	if (status !== undefined && status !== 0) {
		const byStatus = classifyStatus(status);
		if (byStatus.kind !== "unknown") return byStatus;
		const byMessage = classifyErrorMessage(errorMessage);
		if (byMessage === "recoverable") return { kind: "recoverable", cls: "server" };
		if (byMessage === "unrecoverable") return { kind: "unrecoverable", cls: "bad_request" };
		return byStatus;
	}
	// Network-level failure (no HTTP status): classify by message text.
	const byMessage = classifyErrorMessage(errorMessage);
	if (byMessage === "recoverable") return { kind: "recoverable", cls: "server" };
	if (byMessage === "unrecoverable") return { kind: "unrecoverable", cls: "bad_request" };
	// Unknown network errors are usually transient — recoverable.
	return { kind: "recoverable", cls: "server" };
}

/**
 * Abort refinement (pi-free classifyAbort): an abort with a >=500 last
 * status is a failed stream, not user cancellation. Returns null when the
 * abort is a genuine user cancellation (no strike).
 */
export function classifyAbort(lastHttpStatus: number | undefined): FailureKind | null {
	if (lastHttpStatus !== undefined && lastHttpStatus >= 500) return "recoverable";
	return null; // user Esc / timeout without server error — never a strike
}
