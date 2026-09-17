# Contributing

Thanks for improving pi-swarm. Changes should preserve the scheduler's safety
invariants: reserve capacity before sending, never duplicate a journaled side
effect, keep cancellation clean, and never log credential values or response
bodies.

## Prerequisites

- Node.js 22.12 or newer
- npm
- Provider credentials only for live-provider work; use `PI_SWARM_ENV_FILE`
  rather than committing secrets

## Development

```bash
npm ci
npm run lint
npm run test:run
npm run build
```

For the MCP surface, run the local handshake smoke test:

```bash
npx tsx scripts/mcp-client-demo.ts "What is 12*12? Answer with just the number."
```

Provider probes are optional and must never print credential values:

```bash
npx tsx scripts/audit-providers.ts --chat
```

## Pull requests

- Keep changes focused and explain observable behavior in the PR description.
- Add a regression test for a new bug or externally visible contract.
- Update README/docs/examples when setup or configuration changes.
- Do not commit `.env` files, `secrets.*`, SQLite state, provider responses, or
  generated `dist/` output.
- Ensure CI passes on Node 22 and Node 24 before requesting review.

## Release process

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Run `npm run release:check`.
3. Commit the release and create a matching tag, for example `v1.0.0`.
4. Push the branch and tag. The tag workflow verifies the version and publishes
   the package with npm provenance.
5. Confirm the GitHub Actions run, npm package page, and a clean `npx -y
   pi-swarm-mcp` startup before announcing the release.

The release workflow requires an npm publishing credential configured as the
repository's `NPM_TOKEN` secret, unless npm trusted publishing is configured
for this repository.
