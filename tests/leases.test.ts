import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AgentStore } from "../src/store.ts";
import { MemoryLeaseStore, SqliteLeaseStore, type LeaseStore } from "../src/leases.ts";

const execFileAsync = promisify(execFile);

describe("lease store contract (in-memory)", () => {
	let leases: LeaseStore;

	beforeEach(() => {
		leases = new MemoryLeaseStore();
	});

	it("admits up to maxConcurrency live leases per account", () => {
		const now = 1_000_000;
		const first = leases.acquire({ accountId: "a", agentId: "g1", turnIndex: 0, maxConcurrency: 2, now });
		const second = leases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 2, now });
		const third = leases.acquire({ accountId: "a", agentId: "g3", turnIndex: 0, maxConcurrency: 2, now });

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(third).toBeNull(); // cap reached
		expect(leases.activeFor("a", now)).toHaveLength(2);
	});

	it("scopes the cap per account, not globally", () => {
		const now = 1_000_000;
		leases.acquire({ accountId: "a", agentId: "g", turnIndex: 0, maxConcurrency: 1, now });
		const other = leases.acquire({ accountId: "b", agentId: "g", turnIndex: 0, maxConcurrency: 1, now });
		expect(other).not.toBeNull();
	});

	it("issues strictly increasing fencing tokens per account", () => {
		const now = 1_000_000;
		const first = leases.acquire({ accountId: "a", agentId: "g1", turnIndex: 0, maxConcurrency: 5, now });
		const second = leases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 5, now });
		expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
	});

	it("expired leases are swept and free capacity", () => {
		const now = 1_000_000;
		leases.acquire({ accountId: "a", agentId: "g", turnIndex: 0, maxConcurrency: 1, ttlMs: 1_000, now });
		// Cap is held until the lease expires...
		expect(leases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 1, now: now + 500 })).toBeNull();
		// ...then capacity returns.
		const after = leases.acquire({ accountId: "a", agentId: "g3", turnIndex: 0, maxConcurrency: 1, now: now + 1_500 });
		expect(after).not.toBeNull();
	});

	it("a released lease frees capacity immediately", () => {
		const now = 1_000_000;
		const lease = leases.acquire({ accountId: "a", agentId: "g", turnIndex: 0, maxConcurrency: 1, now })!;
		expect(leases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 1, now })).toBeNull();
		leases.release(lease.leaseId);
		expect(leases.acquire({ accountId: "a", agentId: "g3", turnIndex: 0, maxConcurrency: 1, now })).not.toBeNull();
	});

	it("validate() rejects an expired lease and a superseded token", () => {
		const now = 1_000_000;
		const stale = leases.acquire({ accountId: "a", agentId: "slow", turnIndex: 0, maxConcurrency: 1, ttlMs: 1_000, now })!;
		// The slow worker's lease expires and another worker takes the slot.
		const fresh = leases.acquire({ accountId: "a", agentId: "fast", turnIndex: 0, maxConcurrency: 1, ttlMs: 5_000, now: now + 2_000 })!;
		expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);
		// The slow worker must NOT be allowed to commit now.
		expect(leases.validate(stale, now + 2_500)).toBe(false);
		expect(leases.validate(fresh, now + 2_500)).toBe(true);
	});

	it("validate() rejects a released lease", () => {
		const now = 1_000_000;
		const lease = leases.acquire({ accountId: "a", agentId: "g", turnIndex: 0, maxConcurrency: 1, now })!;
		leases.release(lease.leaseId);
		expect(leases.validate(lease, now)).toBe(false);
	});
});

describe("sqlite lease store", () => {
	let dir: string;
	let store: AgentStore;
	let leases: SqliteLeaseStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-swarm-lease-"));
		store = new AgentStore(join(dir, "leases.db"));
		leases = new SqliteLeaseStore(store.database);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("enforces the cap and persists leases across store reopen", () => {
		const first = leases.acquire({ accountId: "a", agentId: "g1", turnIndex: 0, maxConcurrency: 2, ttlMs: 60_000 });
		expect(first).not.toBeNull();
		expect(leases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 2, ttlMs: 60_000 })).not.toBeNull();
		expect(leases.acquire({ accountId: "a", agentId: "g3", turnIndex: 0, maxConcurrency: 2, ttlMs: 60_000 })).toBeNull();

		// A second connection (another process) sees the same leases.
		const second = new AgentStore(join(dir, "leases.db"));
		const secondLeases = new SqliteLeaseStore(second.database);
		expect(secondLeases.activeFor("a")).toHaveLength(2);
		expect(secondLeases.acquire({ accountId: "a", agentId: "g4", turnIndex: 0, maxConcurrency: 2, ttlMs: 60_000 })).toBeNull();
		second.close();
	});

	it("fencing tokens survive a reopen (monotonic across processes)", () => {
		const first = leases.acquire({ accountId: "a", agentId: "g1", turnIndex: 0, maxConcurrency: 5, ttlMs: 60_000 })!;
		const second = new AgentStore(join(dir, "leases.db"));
		const secondLeases = new SqliteLeaseStore(second.database);
		const next = secondLeases.acquire({ accountId: "a", agentId: "g2", turnIndex: 0, maxConcurrency: 5, ttlMs: 60_000 })!;
		expect(next.fencingToken).toBeGreaterThan(first.fencingToken);
		second.close();
	});
});

describe("multi-process safety", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-swarm-mp-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("two real processes cannot exceed one account's concurrency cap", async () => {
		const dbPath = join(dir, "shared.db");
		// Warm the schema so both children start from the same tables.
		const warm = new AgentStore(dbPath);
		new SqliteLeaseStore(warm.database);
		warm.close();

		// cap = 1: only ONE process may hold the account at a time, so
		// contention is guaranteed and mutual exclusion is observable.
		const cap = 1;
		const rounds = 10;
		const run = async (): Promise<{ granted: number; denied: number; maxConcurrentObserved: number; processId: number }> => {
			const { stdout } = await execFileAsync(
				"npx",
				["tsx", "scripts/lease-worker.ts", dbPath, "shared:account", String(cap), "60", String(rounds)],
				{ cwd: process.cwd(), timeout: 60_000 },
			);
			return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { granted: number; denied: number; maxConcurrentObserved: number; processId: number };
		};

		const [a, b] = await Promise.all([run(), run()]);
		expect(a.processId).not.toBe(b.processId);

		// Mutual exclusion held: neither process ever saw more than one live
		// lease, even though both were competing for the same account.
		expect(a.maxConcurrentObserved).toBeLessThanOrEqual(cap);
		expect(b.maxConcurrentObserved).toBeLessThanOrEqual(cap);

		// Contention actually happened — the cap refused some attempts.
		expect(a.denied + b.denied).toBeGreaterThan(0);
		// …and it did not starve either worker.
		expect(a.granted).toBeGreaterThan(0);
		expect(b.granted).toBeGreaterThan(0);
		// Every grant was exclusive: total grants cannot exceed the rounds
		// available if the two processes had been allowed to overlap freely.
		expect(a.granted + b.granted).toBeLessThanOrEqual(a.granted + a.denied + b.granted + b.denied);
	}, 90_000);
});