# pi-swarm

Quota-aware agent-swarm backend: routes concurrent agent turns across
multiple AI provider accounts so no request fails while any eligible
provider still has capacity.

Built on the patterns proven in [pi-free](https://github.com/apmantza/pi-free)
(quota-header parsing, failure classification, TTL+strikes blacklisting),
generalized from "rescue one session" to "schedule N concurrent agents".

## Status

Phases 2–3 of the plan are functional and verified live:

- **83 unit/integration tests green** (quota registry, classifier, blacklist,
  selector, header parsing, circuit breaker, dispatcher, tool journal,
  tool executor, tool loop end-to-end over real HTTP, cancellation tree,
  crash recovery)
- **Live smoke verified** against llm7's anonymous free tier:
  - single agent: spawn → stream → commit → `"4"` (2+2)
  - **6 concurrent agents: 6/6 completed** through a provider whose real
    anonymous limit is ~1 concurrent request — the dispatcher queues behind
    capacity instead of failing (acceptance criterion #3)
  - **tool-using agent: completed** with the correct answer after executing
    the calculator and rerouting once off a model that rejected the tool
    payload (`tool_unsupported_reroute`)

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
| `src/tools.ts` | Tool executor + built-ins (calculator, echo, fetch_text) |
| `src/cancellation.ts` | Parent/child tree, post-order recursive cancel |
| `src/recovery.ts` | Restart reconciliation: interrupted agents, uncertain tools |

## API

```bash
# start (seeds llm7/cline/fastrouter, keyless catalogs where usable)
npm run dev

# spawn an agent
curl -X POST localhost:7463/v1/agents -H 'Content-Type: application/json' \
  -d '{"spec":{"task":"What is 2+2?","maxTurns":2,"maxWallTimeMs":60000,
       "maxProviderAttemptsPerTurn":6,"capabilities":["text"],
       "qualityFloor":null,"allowUnknownQuality":true},
       "idempotencyKey":"unique-key"}'

# status / cancel / capacity
curl localhost:7463/v1/agents/<id>
curl -X DELETE localhost:7463/v1/agents/<id>
curl localhost:7463/v1/capacity
```

Accounts resolve credentials from env (`LLM7_API_KEY`, `CLINE_API_KEY`,
`FASTROUTER_API_KEY`, …). Anonymous accounts are restricted to keyless-usable
tiers (llm7 `turbo`); logged-out accounts whose chat needs a key are excluded
entirely (pi-free #530 rule).

## Verified live behavior (llm7 anonymous)

| Scenario | Result |
| --- | --- |
| Single agent, simple task | completed, correct answer |
| 6 concurrent agents, 1-slot provider | **6/6 completed** via queueing |
| 429 on one model | rerouted to a different model on the same account |
| 401 on one model (anon) | model banned for session; account kept serving |
| 400 on a tool-bearing request | model excluded, rerouted, turn completed |
| Empty 200 from a reasoning-only model | model struck, rerouted (mock-verified) |
| Repeated identical tool call | run stopped early (`tool_loop_detected`) |
| Cancel mid-run | agent cancelled, no circuit strike |
| Restart with a live agent | marked interrupted, transcript preserved |

## Next (plan phases 4–5)

- Phase 4: provider rollout with live quota audits per provider; isolated
  workspaces for tool execution (container/sandbox boundary); SSE event stream
- Phase 5 (only on evidence): shared Redis ledger, multi-process workers,
  lease fencing tokens

## License

MIT
