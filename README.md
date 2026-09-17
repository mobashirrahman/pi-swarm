# pi-swarm

Quota-aware agent-swarm backend: routes concurrent agent turns across
multiple AI provider accounts so no request fails while any eligible
provider still has capacity.

Built on the patterns proven in [pi-free](https://github.com/apmantza/pi-free)
(quota-header parsing, failure classification, TTL+strikes blacklisting),
generalized from "rescue one session" to "schedule N concurrent agents".

## Status

**All phases of the plan are implemented and verified.** 113 tests green.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Empirical provider audit | ✅ `scripts/audit-providers.ts` → `docs/provider-audit.md` |
| 1 | Pure scheduler + simulator | ✅ quota registry, selector, blacklist, circuit breaker |
| 2 | Single-node backend | ✅ dispatcher, agent runtime, SQLite, control API |
| 3 | Reliable agent execution | ✅ tool journal, workspaces, cancellation tree, recovery |
| 4 | Provider rollout + surfaces | ✅ 23-provider catalog, SSE events, sandboxed tools |
| 5 | Scale-out | ✅ **gated by measurement** — see `docs/phase5-evidence.md` |

### Verified live (llm7 anonymous tier + 2 keyed providers)

| Scenario | Result |
| --- | --- |
| Single agent, simple task | completed, correct answer |
| 6 concurrent agents, 1-slot provider | **6/6 completed** via capacity queueing |
| 429 on one model | rerouted to another model on the same account |
| 401/403 on one model | model excluded, turn rerouted (entitlements are per-model) |
| 400 on a tool-bearing request | model excluded, rerouted, turn completed |
| Empty 200 from a reasoning-only model | model struck, rerouted |
| Repeated identical tool call | run stopped early (`tool_loop_detected`) |
| **Workspace tools** | `write_file` → `notes/hello.txt` created inside the sandbox; `read_file` returned it |
| **SSE stream** | `agent.queued → agent.started → tool.executed ×2 → turn.committed` captured live |
| Cancel mid-run | agent cancelled, no circuit strike |
| Restart with a live agent | marked interrupted, transcript preserved |
| 40 concurrent agents with leases | **40/40 completed** (bench harness) |
| Two OS processes, cap = 1 account | mutual exclusion held, no starvation (test) |

## Workspaces (sandbox boundary)

Tool execution is confined by `Workspace`:

- **Filesystem boundary** — every path is root-relative; `..`, absolute paths,
  and symlinks that resolve outside the root are rejected (`path_escape`).
- **Command allowlist** — `echo`, `cat`, `ls`, `wc`, `head`, `tail`, `grep`,
  `sort`, `uniq`, `node`, `python3` by default; anything else is
  `command_denied`.
- **Environment allowlist** — only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`,
  `TMPDIR` reach a child process; secrets in the parent env do not leak.
- **Timeout + output cap + abort** — a hung command is killed (process group),
  output is capped, and an agent abort kills the tree.

Tools: `read_file`, `write_file`, `list_dir`, `run_command`.

## Leases and fencing (multi-process safety)

The in-process quota ledger cannot stop a second process from spending the
same account. `SqliteLeaseStore` is the shared gate:

- `acquire` atomically admits a turn only when the account has fewer than
  `maxConcurrency` live leases (`BEGIN IMMEDIATE` serializes across processes).
- Every lease carries a monotonic **fencing token** per account.
- Validity is row-existence + expiry; the token guards single-holder
  downstream resources.
- A **fairness cooldown** stops a worker re-acquiring an account in the same
  millisecond and monopolizing it (measured: 10/0 split before, fair after).
- Crashed workers' leases are swept, not leaked.

## Events (SSE)

`GET /v1/agents/:id/events` replays the agent's history, then streams live
(`?since=<seq>` resumes after a reconnect). Events carry metadata only —
state, turn index, tool NAME, counts, error class. Never prompts, tool
arguments, or response bodies.

## Tool runtime (Phase 3)

- **Journaled execution** — every tool call has a stable id
  (`agentId:turnIndex:callId`). A completed call replays its recorded result
  instead of running twice; a call left `running` by a crash is reported
  `uncertain` and **never** silently re-run.
- **Built-in tools** — `calculator` (restricted expression evaluator),
  `echo`, `fetch_text` (http/https only, truncated, abort-aware).
- **Failures are data** — a tool error becomes content the model reacts to,
  never a provider failure, never a strike.
- **Timeout vs cancel** — a per-call timeout is a tool failure the model
  sees; an agent abort is cancellation and never strikes the account.
- **Loop guard** — a model repeating the identical tool call stops the run
  early (`tool_loop_detected`) instead of burning quota to `maxTurns`.
- **Capability reroute** — a 400 on a tool-bearing request is treated as
  "this model doesn't accept tools": the model is excluded and the turn
  reroutes. If every candidate 400s, the turn still fails, so a genuinely
  malformed request is not masked.
- **Empty-response reroute** — a 200 with neither content nor tool calls
  (reasoning-only models) is a model defect: strike that model, reroute.

## Reliability (Phase 3)

- **Cancellation tree** — `parentAgentId` links; cancelling a parent cancels
  the whole subtree in post-order (deepest first), so every child observes
  its abort before its parent's terminal transition.
- **Crash recovery** — durable transcript + tool journal in SQLite. On
  restart, mid-flight agents are marked `interrupted_by_restart` with their
  transcript preserved, and tool calls left running are reported as
  uncertain rather than resumed.
- **Idempotent spawn** — `idempotencyKey` returns the existing agent.

## Architecture

```
Orchestrator → POST /v1/agents → SwarmService → Dispatcher
                                    │
                     select → reserve → send → reconcile
                          │           │        │
                     Selector      QuotaRegistry  streamTurn
                     (pure)        (buckets)      (SSE, staged)
```

Key decisions (full rationale in the plan doc):

- **Route by account, not provider** — the allocation unit is
  `provider + credential`; 20 models on one provider share one rate limit.
- **Route every turn** — quota changes mid-agent; binding is soft.
- **Reserve before send** — local decrement closes the burst gap; headers
  reconcile after.
- **Model-scoped reroute** — a 429 on one model reroutes to another model on
  the same account when quota is model-scoped (verified live on llm7).
- **Backpressure, not fail-fast** — exhausted capacity puts the turn in a
  bounded wait (`waiting` behavior), never hammers the provider.
- **Quota strikes age out fast** (30s quota TTL vs 10min session TTL) —
  rate-limit windows refill in seconds.
- **Never a strike for cancellation** — abort without a ≥500 status is
  always clean (pi-free convention 15).
- **Header NAMES only in logs** — never values (pi-free convention 17).

## Modules

| File | Role |
| --- | --- |
| `src/types.ts` | Domain types: accounts, hierarchical quota buckets, candidates |
| `src/quota-registry.ts` | Bucket engine: reserve/commit/release, probation, drift counters |
| `src/quota-headers.ts` | Rate-limit header parsing (6 request pairs + tokens + Retry-After + reset forms) |
| `src/classifier.ts` | Failure taxonomy ported from pi-free auto-fallback |
| `src/blacklist.ts` | TTL + max-strikes, class-aware quota TTL |
| `src/circuit-breaker.ts` | closed → open(cooldown) → half_open → closed |
| `src/selector.ts` | Pure projected-finish router: eligibility → quality → `max(now, nextCapacity) + EWMA` |
| `src/catalog.ts` | Account registry + OpenAI-compatible catalog fetch (free-first, tier-aware) |
| `src/stream.ts` | SSE chat-completions driver with staged output |
| `src/agent.ts` | Turn loop: staged commit, cancel-safe |
| `src/dispatcher.ts` | The scheduler core: select → reserve → send → reroute |
| `src/store.ts` | SQLite (node:sqlite, WAL) agents/attempts/idempotency/transcript/tool journal |
| `src/swarm.ts` | Service facade: spawn/status/cancel/capacity |
| `src/server.ts` | HTTP control API (node:http, zero deps) |
| `src/tool-journal.ts` | Stable-id tool journal (in-memory + SQLite-backed) |
| `src/tools.ts` | Tool executor + built-ins + workspace tools |
| `src/workspace.ts` | Sandbox: filesystem boundary, command/env allowlists, timeouts |
| `src/cancellation.ts` | Parent/child tree, post-order recursive cancel |
| `src/recovery.ts` | Restart reconciliation: interrupted agents, uncertain tools |
| `src/events.ts` | Per-agent event ring + subscribers (SSE source) |
| `src/leases.ts` | Fenced leases: cross-process capacity gate + fairness |
| `src/providers.ts` | 23-provider catalog with credential refs and categories |

## API

```bash
# start (seeds every provider whose credential resolves, plus keyless-chat ones)
npm run dev

# spawn an agent
curl -X POST localhost:7463/v1/agents -H 'Content-Type: application/json' \
  -d '{"spec":{"task":"What is 2+2?","maxTurns":2,"maxWallTimeMs":60000,
       "maxProviderAttemptsPerTurn":6,"capabilities":["text"],
       "qualityFloor":null,"allowUnknownQuality":true},
       "idempotencyKey":"unique-key"}'

# status / cancel / capacity / events
curl localhost:7463/v1/agents/<id>
curl -X DELETE localhost:7463/v1/agents/<id>
curl localhost:7463/v1/capacity
curl -N localhost:7463/v1/agents/<id>/events        # SSE; ?since=<seq> resumes
```

Accounts resolve credentials from env (`LLM7_API_KEY`, `CLINE_API_KEY`,
`FASTROUTER_API_KEY`, …). Anonymous accounts are restricted to keyless-usable
tiers (llm7 `turbo`); logged-out accounts whose chat needs a key are excluded
entirely (pi-free #530 rule).

## Auditing providers

```bash
npx tsx scripts/audit-providers.ts --chat          # all providers → docs/provider-audit.md
npx tsx scripts/audit-providers.ts --chat --only llm7,cline
npx tsx scripts/probe-chat.ts llm7 GLM-5.3-Flash   # one model, header names printed
```

The audit records catalog reachability, free/paid classification, **which
rate-limit header names each provider actually sends**, and which models
answer a chat probe. Credential values are never printed.

Key finding (2026-09-17): **no provider in the catalog sends rate-limit
headers on `/models`**, and anonymous access is per-MODEL rather than
per-tier. That is why the dispatcher runs unknown-quota buckets in probation
mode and treats 401/403 as model-scoped exclusions rather than account deaths.

## Load testing

```bash
npx tsx scripts/bench-scheduler.ts 12 4            # 333 turns/sec
npx tsx scripts/bench-scheduler.ts 40 6 --leases   # 58 turns/sec, 40/40 completed
```

## Scaling

Scale by adding worker processes that share one SQLite database — the lease
store is the coordination point and is already tested for mutual exclusion.
The distributed (Redis) ledger is **not** justified by measurement; see
`docs/phase5-evidence.md` for the numbers and the revisit criteria.

## License

MIT
