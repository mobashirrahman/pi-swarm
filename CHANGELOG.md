# Changelog

All notable changes to pi-swarm are documented here.

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
