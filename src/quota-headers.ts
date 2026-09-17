/**
 * Quota header extraction — ported and EXTENDED from pi-free
 * lib/quota-monitor.ts. pi-free tracks 6 request-pairs (per-minute/day);
 * the swarm also needs reset times, token gauges, and Retry-After.
 *
 * Security: headers are consumed as a Record of names → values here, but
 * only NAMES may ever reach logs (wire-signature convention).
 */

import type { QuotaMetric, QuotaWindow } from "./types.ts";

/** One parsed quota signal from a response. */
export interface HeaderQuota {
	accountId: string;
	metric: QuotaMetric;
	window: QuotaWindow;
	remaining: number;
	limit: number;
	/** Epoch ms the window resets, when the provider says so. */
	resetAt?: number;
}

export interface HeaderParseResult {
	quotas: HeaderQuota[];
	/** Retry-After in ms when a valid header was present. */
	retryAfterMs?: number;
	/**
	 * True when rate-limit-looking headers exist but no known pair matched
	 * (format drift — bump the drift counter, log NAMES only).
	 */
	drift: boolean;
}

/** [remainingHeader, limitHeader, resetHeader?, metric, window] */
type HeaderPair = {
	remaining: string;
	limit: string;
	reset?: string;
	metric: QuotaMetric;
	window: QuotaWindow;
};

const REQUEST_PAIRS: ReadonlyArray<HeaderPair> = [
	// Per-minute (most common) — pi-free priority order.
	{ remaining: "x-ratelimit-remaining-requests", limit: "x-ratelimit-limit-requests", reset: "x-ratelimit-reset-requests", metric: "requests", window: "minute" },
	{ remaining: "x-ratelimit-remaining", limit: "x-ratelimit-limit", reset: "x-ratelimit-reset", metric: "requests", window: "minute" },
	{ remaining: "ratelimit-remaining-requests", limit: "ratelimit-limit-requests", reset: "ratelimit-reset-requests", metric: "requests", window: "minute" },
	{ remaining: "ratelimit-remaining", limit: "ratelimit-limit", reset: "ratelimit-reset", metric: "requests", window: "minute" },
	// Per-day.
	{ remaining: "x-ratelimit-remaining-requests-day", limit: "x-ratelimit-limit-requests-day", reset: "x-ratelimit-reset-requests-day", metric: "requests", window: "day" },
	{ remaining: "x-ratelimit-remaining-day", limit: "x-ratelimit-limit-day", reset: "x-ratelimit-reset-day", metric: "requests", window: "day" },
];

const TOKEN_PAIRS: ReadonlyArray<HeaderPair> = [
	{ remaining: "x-ratelimit-remaining-tokens", limit: "x-ratelimit-limit-tokens", reset: "x-ratelimit-reset-tokens", metric: "tokens", window: "minute" },
	{ remaining: "ratelimit-remaining-tokens", limit: "ratelimit-limit-tokens", reset: "ratelimit-reset-tokens", metric: "tokens", window: "minute" },
];

/** Parse a numeric header; returns undefined for missing/invalid. */
// Quota gauges are non-negative integers. Number() accepts exponent notation
// while rejecting trailing garbage that parseFloat() would silently accept.
function parseNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * Parse reset headers. Values are epoch-seconds, epoch-ms, or a delta like
 * "30s"/"1m30s". Returns epoch ms, or undefined when unparseable.
 */
export function parseResetHeader(raw: string | undefined, now: number): number | undefined {
	if (!raw) return undefined;
	// Duration form FIRST: "1m30s" parseFloat()s as 1 and would be misread
	// as a 1-second delta.
	const trimmed = raw.trim();
	if (/[hms]/.test(trimmed)) {
		const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed);
		if (!match) return undefined;
		const hours = Number.parseInt(match[1] ?? "0", 10);
		const minutes = Number.parseInt(match[2] ?? "0", 10);
		const seconds = Number.parseInt(match[3] ?? "0", 10);
		const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
		return totalMs > 0 ? now + totalMs : undefined;
	}
	const numeric = Number.parseFloat(trimmed);
	if (Number.isFinite(numeric)) {
		// Heuristic: values > 1e12 are already ms; > 1e9 epoch-seconds; else a
		// small delta in seconds (e.g. "30").
		if (numeric > 1e12) return numeric;
		if (numeric > 1e9) return numeric * 1000;
		return now + numeric * 1000;
	}
	return undefined;
}

function parsePairs(
	pairs: ReadonlyArray<HeaderPair>,
	normalized: Record<string, string>,
	accountId: string,
	now: number,
): HeaderQuota[] {
	const result: HeaderQuota[] = [];
	for (const pair of pairs) {
		const remaining = parseNumber(normalized[pair.remaining]);
		const limit = parseNumber(normalized[pair.limit]);
		if (remaining === undefined || limit === undefined || limit <= 0) continue;
		if (remaining > limit) continue; // nonsensical pair
		const resetAt = pair.reset ? parseResetHeader(normalized[pair.reset], now) : undefined;
		result.push({ accountId, metric: pair.metric, window: pair.window, remaining, limit, resetAt });
	}
	return result;
}

/**
 * Extract every quota signal from response headers. Case-insensitive.
 * Duplicate signals for the same (metric, window) keep the FIRST match
 * (priority order).
 */
export function extractQuotaHeaders(
	headers: Record<string, string>,
	accountId: string,
	now: number = Date.now(),
): HeaderParseResult {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = value;
	}

	const quotas: HeaderQuota[] = [];
	const seen = new Set<string>();
	for (const quota of [...parsePairs(REQUEST_PAIRS, normalized, accountId, now), ...parsePairs(TOKEN_PAIRS, normalized, accountId, now)]) {
		const sig = `${quota.metric}/${quota.window}`;
		if (seen.has(sig)) continue;
		seen.add(sig);
		quotas.push(quota);
	}

	const retryAfterRaw = normalized["retry-after"];
	let retryAfterMs: number | undefined;
	if (retryAfterRaw !== undefined) {
		const seconds = Number.parseFloat(retryAfterRaw);
		if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
		else {
			const date = Date.parse(retryAfterRaw);
			if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - now);
		}
	}

	// Drift: rate-limit-ish headers present, but no known pair matched.
	const keys = Object.keys(normalized);
	const hasRemaining = keys.some((k) => /remaining/.test(k));
	const hasLimit = keys.some((k) => /(^|-)limit/.test(k));
	const drift = quotas.length === 0 && hasRemaining && hasLimit;

	return { quotas, retryAfterMs, drift };
}

/**
 * Format a Retry-After into a cooldown target. Pure helper for the
 * scheduler; returns `now` when absent.
 */
export function cooldownTargetFrom(retryAfterMs: number | undefined, now: number, fallbackMs: number): number {
	if (retryAfterMs !== undefined && retryAfterMs > 0) return now + retryAfterMs;
	return now + fallbackMs;
}
