# Changelog

All notable changes to pi-swarm are documented here.

## [1.4.1] - 2026-10-04

Fix the handshake reporting the wrong version.

- `initialize` advertised `serverInfo.version` from a literal that was bumped
  by hand in step with `package.json`, so 1.4.0 answered `1.3.0`. Both
  literals now track the release, and a test reads `package.json` from disk
  and asserts the advertised version matches it and the outbound
  `User-Agent` — the same drift in a test literal is what kept 1.4.0's CI
  green while the server lied.

## [1.4.0] - 2026-10-04

Route through a second wire protocol, exit from chosen countries, and stop
guessing why a gateway said no.

- **Responses driver** (`src/stream-responses.ts`): one turn against an
  OpenAI Responses-API endpoint (`POST {baseUrl}/responses`), streamed over
  SSE with named events. It returns the same `TurnOutcome` as the chat
  driver, so quota, leases, journaling, and transcripts needed no changes.
  Verified live against OpenCode Go: `grok-4.7`, `grok-4.6`, `gpt-6-luna`,
  `gpt-5.6-luna`, and Muse-Spark 1.3/1.2 answer `ModelProtocolUnsupported` on
  `/chat/completions` and work here, text and tool calls both. Capability
  probes route by protocol too, so tools and vision are verified on the
  protocol the model actually serves.
- **OpenCode Go added**, verified live: the $10/mo subscription gateway at
  `opencode.ai/zen/go/v1`. Two requirements are not optional and are now
  satisfied: a real client `User-Agent` (a generic library name draws a
  Cloudflare `error code: 1010`) and a stable `x-opencode-session` per
  conversation, without which Go returns `400 MissingSessionID`. Session
  routing is a provider-declared header, not a hardcoded one. MiniMax is
  excluded client-side because it speaks Anthropic `/messages`, which has no
  driver yet.
- **Geo-egress proxies** (`src/egress.ts`, `docs/egress-proxies.md`): every
  turn picks a random exit from a bring-your-own pool of HTTP/SOCKS5 proxies,
  filtered by ISO-2 country (`egressCountries`, `egressMode`). Fail-closed:
  when a pool is configured and no exit matches, the attempt ends
  `egress_exhausted` rather than silently connecting direct. An exit failure
  blacklists the exit and never strikes the provider account, and proxy
  credentials never reach a log — only proxy ids and redacted hosts.
- **`swarm_egress`**: shows configured exits, countries, and health;
  `check:true` verifies each with a tiny IP-echo request that spends no
  provider quota. Also `GET /v1/egress`.
- **Provider error messages reach the logs.** Both drivers surface the
  upstream `error.message` instead of `HTTP 4xx`, so reroutes and diagnostics
  see the real reason (`AuthError`, `FreeTierError`, `MissingSessionID`,
  `ModelProtocolUnsupported`) rather than a status code.
- **Zen's free tier stays unreachable, deliberately.** `big-pickle` and the
  other Zen-only free models answer `FreeTierError — can only be used from
  within OpenCode`, a server-side gate on client identity that no header
  change should be working around. `longcat-2.5-preview-free`,
  `space-bunny-free`, and `mimo-v2.6-flash` on Go are the free models that do
  route. See `docs/opencode-go-zen-lab-report.md`.
- `undici` is now a runtime dependency (proxy agents are not bundled).

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
