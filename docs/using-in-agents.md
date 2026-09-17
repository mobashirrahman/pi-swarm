# Using pi-swarm inside a coding agent

pi-swarm is an MCP server, so any MCP-capable agent (Oh My Pi, OpenCode,
Claude Code, Cursor, Windsurf, VS Code) can spawn and manage swarm agents as
native tools.

## Tools the agent gets

| Tool | Purpose |
| --- | --- |
| `swarm_spawn` | Start a background agent; returns an agent id immediately |
| `swarm_wait` | Block until the agent finishes; returns its answer |
| `swarm_status` | Current state, final answer / failure reason, event trail |
| `swarm_cancel` | Cancel an agent and every agent it spawned |
| `swarm_capacity` | Per-account circuit state, in-flight turns, remaining quota |
| `swarm_models` | Routing view: which model serves next, and why |
| `swarm_reset` | Close circuits + clear model bans (recover without restart) |

Agents are exposed as `mcp__swarm_<tool>` (e.g. `mcp__swarm_spawn`).

## Oh My Pi

Easiest: install the published package (Node.js 22.12+, no clone needed).
Copy `examples/omp.mcp.json` to one of:

- project: `.omp/mcp.json`
- user: `~/.omp/agent/mcp.json`

Then reload MCP in the session (`/mcp reload`) or restart.

```json
{
  "mcpServers": {
    "swarm": {
      "command": "npx",
      "args": ["-y", "pi-swarm-mcp"]
    }
  }
}
```

From a source checkout, substitute
`"args": ["tsx", "/path/to/pi-swarm/src/mcp-server.ts"]` (run the harness
from the repo so `tsx` resolves) and optionally pin state:

```json
{
  "mcpServers": {
    "swarm": {
      "command": "npx",
      "args": ["tsx", "/path/to/pi-swarm/src/mcp-server.ts"],
      "env": {
        "PI_SWARM_DB": "/path/to/pi-swarm/.pi-swarm.db",
        "PI_SWARM_WORKSPACE": "/path/to/pi-swarm/.pi-swarm-workspace"
      }
    }
  }
}
```

OMP expands `${VAR}` and `${VAR:-default}` in these files, so credentials can
be referenced rather than pasted.

## OpenCode

OpenCode reads `opencode.json` at the project root or
`~/.config/opencode/opencode.json`. Note that **OMP also reads
`opencode.json`**, so a single file can serve both.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "swarm": {
      "type": "local",
      "command": ["npx", "-y", "pi-swarm-mcp"],
      "timeout": 60000
    }
  }
}
```

(`timeout` covers catalog refresh at startup; without it the 5 s default can
fire first. From a source checkout, use
`"command": ["npx", "tsx", "/path/to/pi-swarm/src/mcp-server.ts"]` and run
the harness from the repo.)

OpenCode V2 nests servers under `mcp.servers` and uses `disabled` instead of
`enabled`. Use the shape that matches your installed version.

## Two backends

**Embedded (default).** The MCP server constructs the swarm in-process — no
daemon to start. State lives in `PI_SWARM_DB` (default `.pi-swarm.db`), so
agents spawned in one session are visible to the next.

**Proxy.** Set `PI_SWARM_URL` to attach to a running server instead:

```json
{ "env": { "PI_SWARM_URL": "http://localhost:7463" } }
```

Use proxy mode when several sessions (or machines) should share one swarm,
one quota ledger, and one lease store.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SWARM_URL` | — | Proxy to a running server instead of embedding |
| `PI_SWARM_DB` | `.pi-swarm.db` | SQLite database (shared across sessions) |
| `PI_SWARM_WORKSPACE` | `./.pi-swarm-workspace` | Sandbox root for workspace tools |
| `PI_SWARM_ENV_FILE` | — | Path to a `KEY=VALUE` secrets file for provider credentials (single source of truth; ambient env vars take precedence) |
| `PI_SWARM_LOG_LEVEL` | `info` | `debug` for routing detail |
| `LLM7_API_KEY`, … | — | Provider credentials; unset providers are skipped |

Diagnostics go to **stderr** — stdout carries JSON-RPC frames and nothing
else. If the agent reports protocol errors, check that no wrapper is printing
to stdout.

## Verifying the wiring

```bash
npx tsx scripts/mcp-client-demo.ts "What is 12*12? Answer with just the number."
```

This performs the real handshake and prints:

```
tools: swarm_spawn, swarm_wait, swarm_status, swarm_cancel, swarm_capacity, swarm_models, swarm_reset
capacity: llm7:primary/closed, tokenrouter:primary/closed, bai:primary/closed
agent: agent-...
state: completed
answer: "144"
```

If that works, the harness wiring is correct — any failure is in the agent's
config, not the server.