# Changelog

All notable changes to pi-swarm are documented here.

## [1.3.0] - 2026-09-29

Measure what the swarm actually delivers, and make its agents discoverable.

- **Reliability benchmark** (`scripts/bench-reliability.ts`): the only
  measurement that answers whether the product works. Every task carries a
  judge, so a plausible-but-wrong answer fails instead of passing on
  plausibility and an empty answer fails too. Reports pass rate,
  time-to-completion percentiles, throughput at the chosen concurrency,
  per-account and per-model attribution, reroute count, and failure reasons.
  Attribution reads each agent's own `model.changed` events, so the runtime
  needs no extra bookkeeping. The first live run on a real key file scored
  0.5 pass rate with 1 of 16 accounts serving any turn — the measurement the
  earlier harnesses could not produce.
- **`swarm_agents`**: lists live agents first, then recently finished, each
  with the task's first line and answer size. Filter by `parentAgentId` to
  see one plan's subtasks. Also available as `GET /v1/agents`.

## [1.2.0] - 2026-09-29

Pool health reporting and a wider usable pool.

- **`swarm_doctor`**: diagnoses every configured account with one tiny real
  chat request and reports `ok`, `balance_exhausted`, `chat_failed`,
  `catalog_unreachable`, `unreachable`, `no_routable_models`, or
  `no_credential`. Catalog reachability is not health — Cline lists 460
  models and answers chat with `insufficient_credits`, and Gemini lists 61
  model ids and 404s every one — so the probe must be a real turn. Only
  models the swarm would actually route to are probed, the sweep is bounded
  by one deadline, provider error text is redacted, and routing is never
  changed by a verdict. Also at `GET /v1/doctor`.
- **Free entitlements outrank catalog prices**: some free tiers meter usage
  instead of pricing it at zero (Groq answers 200 on a free key while
  `/models` lists real prices), so an explicit `freeEntitlement` now admits
  a priced model. Seeds carry entitlements.
- **Groq added**, verified live: four free models, all answering 200.
- **llm7 no longer seeded anonymously**: its catalog is paid-only and its
  flagship answers `model_unavailable`, so keyless seeding spent an hourly
  catalog fetch on an empty pool.

## [1.1.3] - 2026-09-29

Correctness and quota-safety fixes found by a repository bug review.

- **Capability probes are budgeted and accounted.** A turn could issue one
  unbudgeted probe per candidate — a 562-model pool meant 562 provider
  requests for a single turn, none of which touched quota or the lease
  store. Probes now cost a per-turn budget (3), run inside the account's
  quota reservation and lease, and are single-flighted across concurrent
  agents. Measured: 562 requests → 4, with no leaked in-flight reservations.
- **Depleted accounts stop churning.** Distinct models answering 402 (an
  exhausted balance, not a closing window) now cool the account, so a
  zero-credits key no longer consumes the whole attempt budget one model at
  a time.
- **Plan `defaults` apply.** Running subtask overrides through the spawn
  parser materialized its defaults (12 turns, `["text","tools"]`), which
  silently overrode the plan's own defaults.
- **A non-numeric `timeoutMs` can no longer hang** `swarm_wait` or
  `swarm_gather`: `Number("abc")` produced a NaN deadline whose expiry test
  never passed, so the request never returned.
- Spec numbers are clamped instead of becoming `NaN` (a `maxTurns` of `NaN`
  produced an instant `max_turns_exceeded`), unknown capabilities are
  dropped, concurrent live agents are capped, unreapable plan children fail
  fast, and plan indexes are released on completion.

## [1.1.2] - 2026-09-28

- Load provider catalogs concurrently: cold start with a full key file drops
  from ~22s to ~7s, inside MCP client health-check timeouts.

## [1.1.1] - 2026-09-28

- Fix `npx -y pi-swarm-mcp`: the published bins now include the
  `pi-swarm-mcp` name, so the documented install command resolves.
- Fix the MCP binary starting a second HTTP server: spec parsing moves to a
  neutral module so bundling no longer trips the server's main-module guard.
- Keyed free-tier accounts admit unpriced models: a resolving credential on
  a free/freemium provider is the free entitlement (paid providers stay
  fail-closed). Verified live: ~647 routable models across keyed accounts.

## [1.1.0] - 2026-09-28

- Quality-first routing tiers (`frontier` / `balanced` / `fast`), selectable
  quality metric, floor, and unknown-quality policy on every spawn; strict
  free-only candidate filtering with explicit free entitlements.
- Fan-out plans: `swarm_plan` runs 1–10 subtasks as concurrent child agents
  and `swarm_gather` collects their answers, over MCP and HTTP.
- Background refresh of intelligence scores and catalogs (hourly,
  `PI_SWARM_REFRESH_MS` override).
- Probed vision/tools capability discovery with a 24h SQLite verdict cache.
- Probation-blocked turns wait for capacity instead of failing fast, so
  siblings queue on one unknown-quota account.

## [1.0.0] - 2026-09-17

Initial public release.

- MCP server with embedded and HTTP-proxy backends.
- Quota-aware multi-provider routing with model scoring and measured telemetry.
- Durable SQLite agent state, leases, recovery, and idempotent tool journaling.
- Sandboxed workspace tools with path, command, environment, timeout, and output
  controls.
- MCP tools for spawning, waiting, status, cancellation, capacity, model
  routing, and administrative reset.
- OpenCode, Oh My Pi, Claude Code, Cursor, Windsurf, and VS Code setup examples.
