/**
 * Lease-holding worker: a separate PROCESS that competes for one account's
 * capacity through the shared SQLite lease table. Used by the multi-process
 * safety test and as a manual harness.
 *
 * Usage: npx tsx scripts/lease-worker.ts <dbPath> <accountId> <maxConcurrency> <holdMs> <rounds>
 *
 * Prints one JSON line: { processId, granted, denied, maxConcurrentObserved }.
 */

import { AgentStore } from "../src/store.ts";
import { SqliteLeaseStore } from "../src/leases.ts";

const [dbPath, accountId, maxConcurrencyRaw, holdMsRaw, roundsRaw] = process.argv.slice(2);
const maxConcurrency = Number.parseInt(maxConcurrencyRaw ?? "2", 10);
const holdMs = Number.parseInt(holdMsRaw ?? "150", 10);
const rounds = Number.parseInt(roundsRaw ?? "10", 10);

const store = new AgentStore(dbPath);
const leases = new SqliteLeaseStore(store.database);

let granted = 0;
let denied = 0;
let maxConcurrentObserved = 0;

for (let round = 0; round < rounds; round++) {
	const lease = leases.acquire({
		accountId,
		agentId: `worker-${process.pid}`,
		turnIndex: round,
		maxConcurrency,
		ttlMs: 30_000,
	});
	if (lease === null) {
		denied += 1;
		// Jittered retry: a FIXED retry interval makes both processes retry in
		// lockstep, and the faster one can win every round (observed: one
		// worker granted 0 of 10 with a fixed 20ms retry). Jitter decorrelates.
		const jitterMs = 10 + Math.floor(Math.random() * 70);
		await new Promise((resolve) => setTimeout(resolve, jitterMs));
		continue;
	}
	granted += 1;
	const active = leases.activeFor(accountId).length;
	maxConcurrentObserved = Math.max(maxConcurrentObserved, active);
	await new Promise((resolve) => setTimeout(resolve, holdMs));
	leases.release(lease.leaseId);
}

process.stdout.write(`${JSON.stringify({ processId: process.pid, granted, denied, maxConcurrentObserved })}\n`);
store.close();