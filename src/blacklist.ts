/**
 * In-session blacklist with TTL + max-strikes — ported from
 * pi-free lib/auto-fallback/blacklist.ts (Q9 = C decision, kept verbatim
 * in spirit).
 *
 * Two eviction rules:
 *  - TTL window: a record older than ttlMs expires; one transient failure
 *    does not permanently ban a serviceable model.
 *  - Max strikes: maxStrikes failures inside the window promote the record
 *    to a hard ban for the rest of the session.
 *
 * Deliberately in-memory only and per-process: "model X was bad last week"
 * decays fast (free providers flip free/paid frequently) — do not persist.
 */

export interface BlacklistEntry {
	/** Consecutive failure count within the current TTL window. */
	count: number;
	/** Epoch ms of the first failure in the current streak. */
	windowStart: number;
	/** Epoch ms of the most recent failure (for history rendering). */
	lastFailureAt: number;
	/** Short error-class labels, capped. NEVER full error bodies. */
	reasons: string[];
}

export interface BlacklistOptions {
	ttlMs?: number;
	maxStrikes?: number;
	maxReasons?: number;
	/**
	 * Shorter TTL for quota-class failures: rate-limit windows refill in
	 * seconds-to-minutes; a 429 strike should not shadow a model for the
	 * full session TTL. 0 disables the split (all failures use ttlMs).
	 */
	quotaTtlMs?: number;
}

export class Blacklist {
	private readonly entries = new Map<string, BlacklistEntry>();
	private readonly ttlMs: number;
	private readonly quotaTtlMs: number;
	private readonly maxStrikes: number;
	private readonly maxReasons: number;

	constructor(options: BlacklistOptions = {}) {
		this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
		this.quotaTtlMs = options.quotaTtlMs ?? 30_000;
		this.maxStrikes = options.maxStrikes ?? 3;
		this.maxReasons = options.maxReasons ?? 5;
	}

	/** Effective TTL for a failure class. */
	private ttlFor(reason: string): number {
		return reason === "quota" ? this.quotaTtlMs : this.ttlMs;
	}

	/**
	 * Record a failure for a key ("accountId/modelId"). The TTL window is
	 * class-aware: quota strikes age out fast (windows refill), other
	 * failures use the session TTL.
	 */
	recordFailure(key: string, reason: string, now: number): BlacklistEntry {
		const existing = this.entries.get(key);
		const effectiveTtl = Math.min(this.ttlFor(reason), this.ttlFor(existing?.reasons[0] ?? reason));
		if (existing && now - existing.lastFailureAt > effectiveTtl) {
			// TTL window expired — reset the streak.
			this.entries.delete(key);
		}
		const current = this.entries.get(key);
		const entry: BlacklistEntry = {
			count: (current?.count ?? 0) + 1,
			windowStart: current?.windowStart ?? now,
			lastFailureAt: now,
			reasons: [...(current?.reasons ?? []), reason].slice(-this.maxReasons),
		};
		this.entries.set(key, entry);
		return entry;
	}

	/** Remove the record (on success or explicit reset). Idempotent. */
	clear(key: string): void {
		this.entries.delete(key);
	}

	/** Clear every entry. Returns how many were present. */
	clearAll(): number {
		const n = this.entries.size;
		this.entries.clear();
		return n;
	}

	/**
	 * Clear every entry scoped to one account ("accountId/modelId" keys).
	 * Used by administrative capacity resets; per-model TTL expiry still
	 * handles the normal case. Returns how many were cleared.
	 */
	clearAccount(accountId: string): number {
		let n = 0;
		for (const key of this.entries.keys()) {
			if (key === accountId || key.startsWith(`${accountId}/`)) {
				this.entries.delete(key);
				n += 1;
			}
		}
		return n;
	}

	/**
	 * Blacklisted right now? Hard ban (>= maxStrikes) persists for the
	 * session; soft ban must still be inside the class TTL window.
	 */
	isBlacklisted(key: string, now: number): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		if (entry.count >= this.maxStrikes) return true;
		const effectiveTtl = Math.min(this.ttlFor(entry.reasons[0] ?? ""), this.ttlFor(entry.reasons[entry.reasons.length - 1] ?? ""));
		if (now - entry.lastFailureAt > effectiveTtl) {
			// Expiry is also eviction: dynamic catalogs can produce many
			// transient model keys, so stale soft bans must not grow forever.
			this.entries.delete(key);
			return false;
		}
		return true;
	}

	/** Read-only snapshot for /capacity or history views. */
	snapshot(): ReadonlyMap<string, BlacklistEntry> {
		return new Map(this.entries);
	}

	size(): number {
		return this.entries.size;
	}
}
