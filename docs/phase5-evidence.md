# Phase 5 gate: is one scheduler enough?

The plan says do **not** go distributed until a single scheduler is a measured
bottleneck. This records the measurement and the resulting decision.

Reproduce with:

```bash
npx tsx scripts/bench-scheduler.ts 12 4            # single-process
npx tsx scripts/bench-scheduler.ts 40 6 --leases   # with SQLite leases
```

Both runs drive the real `Dispatcher` against a local fake provider over real
HTTP (real quota registry, real lease store, real SSE-free path). `BENCH_THINK_MS`
(default 120) simulates provider latency.

## Measured (2026-09-17, Apple M4, Node 25)

| Scenario | Agents | Turns | Wall | Turns/sec | p50 agent | p95 agent | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Single-process | 12 | 48 | 144 ms | **333** | 139 ms | 141 ms | 0 |
| SQLite leases | 40 | 240 | 4166 ms | **58** | 2148 ms | 4158 ms | 0 |

## What the aggregate free-tier ceiling actually is

The workload this scheduler exists to serve is bounded by provider quota, not
by the scheduler. Free tiers observed live during this project:

- llm7 anonymous: ~1 concurrent request, refills on ~15 s scales
- typical free tiers: 1–20 requests/minute per account

Even at a generous 20 RPM × 20 accounts, the aggregate is ~400 requests/minute
≈ **6.7 turns/second**. The single-process scheduler measured 333 turns/sec
(no leases) and 58 turns/sec (with cross-process leases) — **8× to 50× the
entire plausible provider ceiling**.

## Decision

**Do not build the distributed ledger.** Phase 5's distributed half
(Redis-backed shared state, multi-process worker fleet) is not justified by
measurement: the scheduler is not the bottleneck, and one writer keeps quota
coordination simple and correct.

What was built instead is the part that removes the single-process *correctness*
limit without distributing the scheduler:

- **SQLite lease store with fencing tokens** — several worker processes can
  share one database and one account pool without overspending it. Proven by a
  test that spawns two real processes competing for `cap = 1`
  (`tests/leases.test.ts`): mutual exclusion held, contention was refused, and
  neither worker starved.
- **`scripts/bench-scheduler.ts`** — the harness above, so the gate can be
  re-evaluated on real hardware rather than argued about.

## Cost of the lease store

Leases cost throughput (333 → 58 turns/sec) because every turn takes a SQLite
write lock. That is an acceptable trade: it buys cross-process safety, and the
resulting 58 turns/sec is still an order of magnitude above the provider
ceiling. Single-process deployments can omit the store and keep full speed.

## Bugs this measurement surfaced

Both were real defects that only appeared under concurrent load:

1. **Fencing compared tokens against the account's maximum.** An account
   admits `maxConcurrency` holders, so a newer peer lease legitimately carries
   a higher token — the comparison invalidated valid in-flight work
   (31 of 40 agents failed with `stale_lease_rejected`). Fixed: validity is
   row-existence + expiry; the token remains for single-holder downstream
   resources.
2. **Fairness cooldown was too long (250 ms).** It prevented monopolization
   but throttled legitimate sequential turns. Reduced to 25 ms — enough to
   break lockstep re-acquisition, small enough not to throttle.

## When to revisit

Re-run the harness and go distributed only if **all** hold:

1. measured turns/sec is within 2× of the aggregate provider ceiling;
2. the workload is CPU/DB-bound rather than quota-bound (check provider wait
   time as a fraction of turn latency);
3. a single scheduler process saturates one core.

Until then, scale by adding worker processes that share the SQLite lease
store — that path is already tested.