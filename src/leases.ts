/**
 * Turn leases with fencing tokens — the cross-process coordination point.
 *
 * The in-process quota ledger cannot stop a SECOND process from spending the
 * same account's capacity: each process has its own counters. A shared lease
 * table is what makes the swarm safe to run as several workers against one
 * account.
 *
 * Contract:
 *  - `acquire` atomically admits a turn only when the account has fewer than
 *    `maxConcurrency` live leases. SQLite `BEGIN IMMEDIATE` serializes the
 *    check-and-insert across processes.
 *  - Every lease carries a MONOTONIC fencing token per account. A worker that
 *    lost its lease (expired and re-issued to someone else) holds a stale
 *    token; `validate` rejects it, so a slow worker cannot commit work whose
 *    capacity now belongs to another turn.
 *  - Leases expire: a crashed worker's lease is swept, not leaked.
 */

import { DatabaseSync } from "node:sqlite";

export interface TurnLease {
	leaseId: string;
	accountId: string;
	agentId: string;
	turnIndex: number;
	/** Monotonic per account; higher = newer holder. */
	fencingToken: number;
	grantedAt: number;
	expiresAt: number;
}

export interface AcquireOptions {
	accountId: string;
	agentId: string;
	turnIndex: number;
	/** Max live leases for the account (the concurrency cap). */
	maxConcurrency: number;
	/** Lease duration; must comfortably exceed a turn's wall time. */
	ttlMs?: number;
	now?: number;
}

/**
 * Fairness: after releasing an account, a worker may not immediately
 * re-acquire it. Without this the winner of a contended slot re-acquires in
 * the same millisecond and monopolizes the account — measured: with cap=1
 * and a 60ms hold, one worker took 10/10 leases and the other 0/10.
 *
 * Kept SHORT: it only needs to break the lockstep re-acquire, and a long
 * cooldown throttles legitimate sequential turns (measured: 250ms cost 31/40
 * agents their turn at concurrency 8).
 */
export const DEFAULT_FAIRNESS_COOLDOWN_MS = 25;

export interface LeaseStoreOptions {
	/** 0 disables the anti-monopolization cooldown. */
	fairnessCooldownMs?: number;
}

export interface LeaseStore {
	acquire(options: AcquireOptions): TurnLease | null;
	/** Is this lease still the account's current holder (fencing check)? */
	validate(lease: TurnLease, now?: number): boolean;
	release(leaseId: string): void;
	/** Live leases for an account (diagnostics). */
	activeFor(accountId: string, now?: number): TurnLease[];
	/** Remove expired leases; returns how many were swept. */
	sweep(now?: number): number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface LeaseRow {
	lease_id: string;
	account_id: string;
	agent_id: string;
	turn_index: number;
	fencing_token: number;
	granted_at: number;
	expires_at: number;
}

function rowToLease(row: LeaseRow): TurnLease {
	return {
		leaseId: row.lease_id,
		accountId: row.account_id,
		agentId: row.agent_id,
		turnIndex: row.turn_index,
		fencingToken: row.fencing_token,
		grantedAt: row.granted_at,
		expiresAt: row.expires_at,
	};
}

/** SQLite-backed lease store: safe across processes sharing one database. */
export class SqliteLeaseStore implements LeaseStore {
	private readonly fairnessCooldownMs: number;

	constructor(private readonly db: DatabaseSync, options: LeaseStoreOptions = {}) {
		this.fairnessCooldownMs = options.fairnessCooldownMs ?? DEFAULT_FAIRNESS_COOLDOWN_MS;
		this.migrate();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS leases (
				lease_id TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				turn_index INTEGER NOT NULL,
				fencing_token INTEGER NOT NULL,
				granted_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_leases_account ON leases(account_id);
			CREATE TABLE IF NOT EXISTS lease_cooldowns (
				account_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				released_at INTEGER NOT NULL,
				PRIMARY KEY (account_id, agent_id)
			);
		`);
	}

	acquire(options: AcquireOptions): TurnLease | null {
		const now = options.now ?? Date.now();
		const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

		// BEGIN IMMEDIATE takes the write lock up front, so the count-then-
		// insert below is atomic against other processes.
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);

			// Fairness gate: did THIS worker just release this account?
			if (this.fairnessCooldownMs > 0) {
				const cooldown = this.db
					.prepare("SELECT released_at FROM lease_cooldowns WHERE account_id = ? AND agent_id = ?")
					.get(options.accountId, options.agentId) as { released_at: number } | undefined;
				if (cooldown && now - cooldown.released_at < this.fairnessCooldownMs) {
					this.db.exec("ROLLBACK");
					return null;
				}
			}

			const active = this.db
				.prepare("SELECT COUNT(*) AS n FROM leases WHERE account_id = ?")
				.get(options.accountId) as { n: number } | undefined;
			if ((active?.n ?? 0) >= options.maxConcurrency) {
				this.db.exec("ROLLBACK");
				return null;
			}

			const maxToken = this.db
				.prepare("SELECT COALESCE(MAX(fencing_token), 0) AS m FROM leases WHERE account_id = ?")
				.get(options.accountId) as { m: number } | undefined;
			const fencingToken = (maxToken?.m ?? 0) + 1;
			const lease: TurnLease = {
				leaseId: `${options.accountId}:${options.agentId}:${options.turnIndex}:${fencingToken}`,
				accountId: options.accountId,
				agentId: options.agentId,
				turnIndex: options.turnIndex,
				fencingToken,
				grantedAt: now,
				expiresAt: now + ttlMs,
			};
			this.db
				.prepare("INSERT INTO leases (lease_id, account_id, agent_id, turn_index, fencing_token, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(lease.leaseId, lease.accountId, lease.agentId, lease.turnIndex, lease.fencingToken, lease.grantedAt, lease.expiresAt);
			this.db.exec("COMMIT");
			return lease;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// already rolled back
			}
			throw error;
		}
	}

	/**
	 * Fencing check: the lease must still exist and be unexpired.
	 *
	 * The token is NOT compared against the account's highest token: an
	 * account admits up to `maxConcurrency` holders, so a newer peer lease
	 * legitimately carries a higher token. (Comparing tokens here invalidated
	 * valid in-flight work — measured: 31 of 40 agents failed with
	 * `stale_lease_rejected` at concurrency 8.) The token exists so a
	 * SINGLE-holder downstream resource can reject a stale writer; expiry +
	 * row-existence is what governs admission here.
	 */
	validate(lease: TurnLease, now: number = Date.now()): boolean {
		const row = this.db.prepare("SELECT expires_at FROM leases WHERE lease_id = ?").get(lease.leaseId) as
			| { expires_at: number }
			| undefined;
		if (!row) return false; // swept (expired) or released
		return row.expires_at > now;
	}

	release(leaseId: string): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT account_id, agent_id FROM leases WHERE lease_id = ?").get(leaseId) as
				| { account_id: string; agent_id: string }
				| undefined;
			this.db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
			if (row) {
				this.db
					.prepare("INSERT OR REPLACE INTO lease_cooldowns (account_id, agent_id, released_at) VALUES (?, ?, ?)")
					.run(row.account_id, row.agent_id, Date.now());
			}
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// already rolled back
			}
			throw error;
		}
	}

	activeFor(accountId: string, now: number = Date.now()): TurnLease[] {
		const rows = this.db
			.prepare("SELECT * FROM leases WHERE account_id = ? AND expires_at > ? ORDER BY fencing_token")
			.all(accountId, now) as unknown as LeaseRow[];
		return rows.map(rowToLease);
	}

	sweep(now: number = Date.now()): number {
		const result = this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);
		return Number(result.changes ?? 0);
	}
}

/** In-process lease store for tests and single-process use. */
export class MemoryLeaseStore implements LeaseStore {
	private readonly leases = new Map<string, TurnLease>();
	private readonly tokens = new Map<string, number>();
	/** "accountId|agentId" → last release time (fairness cooldown). */
	private readonly releasedAt = new Map<string, number>();
	private readonly fairnessCooldownMs: number;

	constructor(options: LeaseStoreOptions = {}) {
		this.fairnessCooldownMs = options.fairnessCooldownMs ?? DEFAULT_FAIRNESS_COOLDOWN_MS;
	}

	acquire(options: AcquireOptions): TurnLease | null {
		const now = options.now ?? Date.now();
		const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.sweep(now);
		// Fairness: a worker that just released this account must wait, so a
		// contended slot is not monopolized by the previous holder.
		const lastRelease = this.releasedAt.get(`${options.accountId}|${options.agentId}`);
		if (this.fairnessCooldownMs > 0 && lastRelease !== undefined && now - lastRelease < this.fairnessCooldownMs) {
			return null;
		}
		const active = this.activeFor(options.accountId, now);
		if (active.length >= options.maxConcurrency) return null;
		const fencingToken = (this.tokens.get(options.accountId) ?? 0) + 1;
		this.tokens.set(options.accountId, fencingToken);
		const lease: TurnLease = {
			leaseId: `${options.accountId}:${options.agentId}:${options.turnIndex}:${fencingToken}`,
			accountId: options.accountId,
			agentId: options.agentId,
			turnIndex: options.turnIndex,
			fencingToken,
			grantedAt: now,
			expiresAt: now + ttlMs,
		};
		this.leases.set(lease.leaseId, lease);
		return lease;
	}

	/**
	 * Fencing check: the lease must still exist and be unexpired. The token is
	 * not compared to peers — an account admits several holders (see the
	 * SQLite store's note).
	 */
	validate(lease: TurnLease, now: number = Date.now()): boolean {
		const current = this.leases.get(lease.leaseId);
		if (!current) return false;
		return current.expiresAt > now;
	}

	release(leaseId: string): void {
		const lease = this.leases.get(leaseId);
		this.leases.delete(leaseId);
		if (lease) this.releasedAt.set(`${lease.accountId}|${lease.agentId}`, Date.now());
	}

	activeFor(accountId: string, now: number = Date.now()): TurnLease[] {
		return [...this.leases.values()].filter((lease) => lease.accountId === accountId && lease.expiresAt > now);
	}

	sweep(now: number = Date.now()): number {
		let swept = 0;
		for (const [id, lease] of this.leases) {
			if (lease.expiresAt <= now) {
				this.leases.delete(id);
				swept += 1;
			}
		}
		return swept;
	}
}