# pi-swarm — agent instructions

Quota-aware agent-swarm MCP server (`swarm_spawn`, `swarm_wait`,
`swarm_status`, `swarm_cancel`, `swarm_plan`, `swarm_gather`,
`swarm_agents`, `swarm_doctor`, `swarm_capacity`, `swarm_models`,
`swarm_reset`, `swarm_egress`). TypeScript, strict, ES2023, Node 22.12+.

## Everyday commands

```bash
npm run install:harnesses                  # build + keys + wire OpenCode/Claude/Codex + quota-free check
npm run install:harnesses -- --dry-run     # preview only; also: --skip-build, --verify (spends quota)
npm run mcp:verify -- <config> swarm       # full spawn+wait check of one harness config
npm run lint                               # tsc --noEmit (covers src/ + tests/ ONLY)
npm run test:run                           # vitest, 28 files
npm run build                              # esbuild -> dist/ (also runs via prepare on npm install)
```

`scripts/` is **not** covered by `npm run lint`. Typecheck a script
standalone, e.g.:

```bash
npx tsc --noEmit --strict --skipLibCheck --allowImportingTsExtensions \
  --module nodenext --moduleResolution nodenext --target es2023 \
  --types node scripts/<name>.ts
```

## How the pieces fit

- Harnesses spawn `dist/mcp-server.js` directly (absolute node path, no
  `npx`). After any `src/` change, rebuild or they serve a stale bundle.
  `dist/` is gitignored.
- Credentials live in `secrets.env` (gitignored, `chmod 600`), loaded via
  `PI_SWARM_ENV_FILE`. Provider key names come from `credentialRef` in
  `src/providers.ts` — import `PROVIDER_SEEDS`, never hardcode the list.
- Harness configs: `~/.config/opencode/opencode.jsonc` (`mcp.swarm`,
  env key is `environment`), `~/.claude.json` (`mcpServers.swarm`, env key
  is `env`), `~/.codex/config.toml` (`[mcp_servers.swarm]` + `.env`,
  TOML — parse with `python3 -c "...tomllib..."`, no parser dep).
- MCP wire: JSON-RPC over stdio, protocol `2024-11-05`, logs on stderr,
  frames on stdout only. `package.json` is the version source of truth;
  `SERVER_VERSION` (`src/mcp-server.ts`) and `PI_SWARM_USER_AGENT`
  (`src/fetch.ts`) must match it — `tests/mcp.test.ts` enforces this.

## Hard rules

- **Never print, log, or commit credential values.** Status lines may say
  only `set` / `kept` / `MISSING` per key name. This applies to code,
  scripts, tests, docs, and chat output.
- Never commit `secrets.*`, `*.env`, SQLite state (`*.db*`),
  `.pi-swarm-workspace/`, provider responses, or `dist/`.
- Back up a harness config (`<file>.bak`) before the first write; re-runs
  must be no-ops when already current.
- Version-pinned `npx` (`pi-swarm-mcp@x.y.z`) breaks when cwd is this repo
  (npx satisfies the spec from the local `package.json`, then execs a bin
  that isn't installed). Use the absolute node path to `dist/`.
- Release process lives in `CONTRIBUTING.md`. User-facing setup lives in
  `README.md#install` — update both when setup or configuration changes.
