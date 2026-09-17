/**
 * Fetch primitives with timeout, deadline, and full-jitter backoff.
 * Ported from pi-free lib/fetch.ts; the retry-in-`fetchWithRetry` behavior
 * is deliberately NOT used for model turns (the scheduler owns retry policy
 * for those) — only for catalog fetches and probes.
 */

/** Async sleep helper. */
export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Fetch with timeout using AbortController. An upstream signal aborts the
 * fetch immediately with the upstream reason preserved.
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs = 30_000,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const upstreamSignal = options.signal;
	const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

	if (upstreamSignal?.aborted) {
		abortFromUpstream();
	} else {
		upstreamSignal?.addEventListener("abort", abortFromUpstream, {
			once: true,
		});
	}

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
		upstreamSignal?.removeEventListener("abort", abortFromUpstream);
	}
}

/** Upper bound for a single retry backoff sleep. */
export const MAX_RETRY_BACKOFF_MS = 10_000;

/**
 * Full-jitter exponential backoff: `random(0, min(base * 2^attempt, cap))`.
 * Full jitter decorrelates concurrent retries against the same gateway
 * (thundering herd). Pure and exported for unit testing.
 */
export function computeRetryBackoffMs(
	attempt: number,
	baseDelayMs: number,
	options: { capMs?: number; random?: () => number } = {},
): number {
	const { capMs = MAX_RETRY_BACKOFF_MS, random = Math.random } = options;
	const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 0;
	const safeBase = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
	const cap =
		Number.isFinite(capMs) && capMs > 0 ? Math.min(capMs, MAX_RETRY_BACKOFF_MS) : MAX_RETRY_BACKOFF_MS;
	return random() * Math.min(safeBase * 2 ** safeAttempt, cap);
}

/**
 * Fetch with retry logic and timeout. 429 throws immediately (the caller
 * must react to rate limits, not sleep-and-retry); 5xx backs off and retries.
 * Non-retryable non-ok statuses are returned for caller-side handling.
 */
export async function fetchWithRetry(
	url: string,
	options: RequestInit,
	retries = 3,
	delayMs = 1000,
	timeoutMs = 30_000,
): Promise<Response> {
	let lastError: unknown;

	for (let i = 0; i < retries; i++) {
		try {
			const response = await fetchWithTimeout(url, options, timeoutMs);
			if (response.ok) return response;

			if (response.status === 429) {
				throw new Error("Rate limited (429)");
			}

			if (response.status >= 500) {
				lastError = new Error(`Server error ${response.status}`);
				if (i < retries - 1) {
					await sleep(computeRetryBackoffMs(i, delayMs));
					continue;
				}
				throw lastError;
			}

			return response; // non-ok, non-retryable — caller decides
		} catch (error) {
			lastError = error;
			if (options.signal?.aborted) throw error;
			if (i < retries - 1) {
				await sleep(computeRetryBackoffMs(i, delayMs));
			}
		}
	}

	throw lastError;
}
