/**
 * Account circuit breaker: closed → open(cooldown) → half_open → closed|open.
 *
 * Account-wide failures (auth, policy, quota storms, gateway outages) open
 * the circuit for the whole account; model-scoped problems go to the
 * Blacklist instead. Backoff is exponential with a cap, seeded from
 * Retry-After when the provider supplies one.
 */

import type { AccountCircuitState } from "./types.ts";

export interface CircuitOptions {
	/** Base cooldown on first open (ms). */
	baseCooldownMs?: number;
	/** Max cooldown (ms). */
	maxCooldownMs?: number;
	/** Consecutive failures before the circuit opens. */
	threshold?: number;
	/** Consecutive successes in half_open needed to close. */
	halfOpenSuccesses?: number;
}

const DEFAULT_BASE_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_HALF_OPEN_SUCCESSES = 1;

export class CircuitBreaker {
	private readonly state = new Map<string, AccountCircuitState>();
	private readonly baseCooldownMs: number;
	private readonly maxCooldownMs: number;
	private readonly threshold: number;
	private readonly halfOpenSuccesses: number;
	/** Successes counted in the current half_open probe. */
	private readonly halfOpenProgress = new Map<string, number>();

	constructor(options: CircuitOptions = {}) {
		this.baseCooldownMs = options.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS;
		this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
		this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
		this.halfOpenSuccesses = options.halfOpenSuccesses ?? DEFAULT_HALF_OPEN_SUCCESSES;
	}

	get(accountId: string): Readonly<AccountCircuitState> {
		return (
			this.state.get(accountId) ?? {
				accountId,
				state: "closed",
				cooldownUntil: 0,
				consecutiveFailures: 0,
			}
		);
	}

	/** Can a request be admitted right now? half_open admits ONE probe. */
	canAdmit(accountId: string, now: number): boolean {
		const s = this.state.get(accountId);
		if (!s || s.state === "closed") return true;
		if (s.state === "open") {
			if (now >= s.cooldownUntil) {
				// Transition to half_open lazily on next evaluation.
				this.state.set(accountId, { ...s, state: "half_open" });
				this.halfOpenProgress.set(accountId, 0);
				return true;
			}
			return false;
		}
		// half_open: exactly one probe in flight; tracked by caller via
		// recordSuccess/recordFailure. Admission allowed (the single probe).
		return true;
	}

	/**
	 * Record a failure. `retryAfterMs` (from Retry-After header) seeds the
	 * cooldown; otherwise exponential backoff from consecutive failures.
	 */
	recordFailure(accountId: string, now: number, retryAfterMs?: number): void {
		const s = this.get(accountId);
		const consecutive = s.consecutiveFailures + 1;

		if (s.state === "half_open") {
			// Probe failed — reopen with fresh backoff.
			this.state.set(accountId, {
				accountId,
				state: "open",
				cooldownUntil: now + this.cooldownFor(consecutive, retryAfterMs),
				consecutiveFailures: consecutive,
			});
			this.halfOpenProgress.delete(accountId);
			return;
		}

		if (consecutive >= this.threshold) {
			this.state.set(accountId, {
				accountId,
				state: "open",
				cooldownUntil: now + this.cooldownFor(consecutive, retryAfterMs),
				consecutiveFailures: consecutive,
			});
		} else {
			this.state.set(accountId, { ...s, consecutiveFailures: consecutive });
		}
	}

	/** Record a success. Closes the circuit after enough half_open wins. */
	recordSuccess(accountId: string): void {
		const s = this.state.get(accountId);
		if (!s || s.state === "closed") return;
		if (s.state === "half_open") {
			const progress = (this.halfOpenProgress.get(accountId) ?? 0) + 1;
			if (progress >= this.halfOpenSuccesses) {
				this.state.set(accountId, {
					accountId,
					state: "closed",
					cooldownUntil: 0,
					consecutiveFailures: 0,
				});
				this.halfOpenProgress.delete(accountId);
			} else {
				this.halfOpenProgress.set(accountId, progress);
			}
			return;
		}
		// Success while closed: reset the failure streak.
		this.state.set(accountId, { ...s, consecutiveFailures: 0 });
	}

	/** Immediate administrative open (e.g. 401 → credential problem). */
	openUntil(accountId: string, until: number, now: number): void {
		this.state.set(accountId, {
			accountId,
			state: until > now ? "open" : "closed",
			cooldownUntil: until,
			consecutiveFailures: this.get(accountId).consecutiveFailures,
		});
	}

	private cooldownFor(consecutiveFailures: number, retryAfterMs?: number): number {
		if (retryAfterMs !== undefined && retryAfterMs > 0) {
			return Math.min(retryAfterMs, this.maxCooldownMs);
		}
		const exponential = this.baseCooldownMs * 2 ** (consecutiveFailures - this.threshold);
		return Math.min(Math.max(exponential, this.baseCooldownMs), this.maxCooldownMs);
	}
}
