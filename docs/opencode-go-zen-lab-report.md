# OpenCode Go vs Zen — gateway lab report

Date: 2026-10-04. Scope: protocol shape, required headers, model routing, and
error envelopes observed from `opencode.ai/zen/v1` (Zen) and
`opencode.ai/zen/go/v1` (Go), using a real Go subscription key in
`OPENCODE_API_KEY`. Credential values are never reproduced.

## TL;DR

- Zen paid chat models (OpenAI-compatible) and free `-free` models: chat
  works with the API key **only when it is used exactly the way OpenCode
  clients use it**. Free models are additionally gated by
  `FreeTierError` for non-OpenCode clients (observed live).
- Go subscription models: routable from pi-swarm for the models that share
  our OpenAI-compatible chat driver, and for `responses`-protocol models now
  that `src/stream-responses.ts` exists. This is the supported path.
- Go is **not a free tier**: free models are `longcat-2.5-preview-free` and
  `space-bunny-free` (limited-time unlimited). Everything else spends
  subscription quota. Zen's separate free pool is NOT accessible from
  pi-swarm today.

## Endpoints and protocols

| Surface | Chat-compatible models | `responses` models | Anthropic `messages` | Other |
| --- | --- | --- | --- | --- |
| Zen (`/zen/v1`) | `/chat/completions` (Big Pickle, MiMo frees, Nemotron frees, etc.) | `/responses` (grok-4.7/4.6/4.5, gpt-*, muse-spark-contributor) | `/messages` (Claude, Qwen Plus/Max) | `/systemone` (Jev), `/models/<id>` for Google-native Gemini |
| Go (`/zen/go/v1`) | `/chat/completions` — grok-4.7/4.6 excluded per docs; 28-ish chat models | `/responses` — grok-4.7, grok-4.6, gpt-6-luna, gpt-5.6-luna, muse-spark 1.3/1.2 | `/messages` — minimax-m3/m2.7 (excluded by design) | none observed |

Endpoint tables confirmed against `opencode.ai/docs/zen` and
`opencode.ai/docs/go` on 2026-10-04.

## Required headers / quotas

| Requirement | Evidence | Behavior when absent |
| --- | --- | --- |
| Real client UA on Zen/Go | python-requests UA gets Cloudflare-style `error code: 1010` (no JSON, plain text 403); browser-class UA succeeds for `/models` | `403`, body `error code: 1010\n` |
| Stable session id on Go | Go variants return `400 MissingSessionID` without it | `400`, `{"type":"error","error":{"type":"MissingSessionID",...}}` |
| Valid Go subscription key | invalid key on either endpoint → `401 AuthError` | `401`, `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}` |
| Privacy/entitlement for Spark | `400 server_error: "This Go model trains on request data. Allow paid endpoints that train on request data in your workspace's Privacy settings to use it."` | upstream policy block, not pathable without account setting |

pi-swarm satisfies UA + session requirements for every probe: `User-Agent: pi-swarm/1.3.0` and `x-opencode-session: <agentId>`.

## Error envelope shapes

- Model-level upstream failure on Go:
  `{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`
- Protocol mismatch:
  `{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}`
- Unsupported model on Go:
  `{"type":"error","error":{"type":"ModelError","message":"Model big-pickle is not supported"}}`
- Missing session:
  `{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently..."}}`
- Free-tier gate on Zen (pi-swarm client):
  `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}`
- Key rejection on Zen/Go:
  `{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`

`streamTurn` / `streamResponsesTurn` now surface the inner `error.message`
(rather than `HTTP 4xx`) so reroutes and diagnostics see these reasons.

## Model routing from a normal client

Legend: ✅ verified valid in pi-swarm via live probe, ❌ rejected, ⚠️ needs
account-side setting, — not tested in this pass.

| Model | Zen | Go |
| --- | --- | --- |
| `big-pickle` (free) | ❌ FreeTierError on current client | ❌ ModelError not supported |
| `mimo-v2.6-flash` | — | ✅ text works |
| `longcat-2.5-preview-free` (free) | — | ✅ text works |
| `space-bunny-free` (free) | — | expected ✅ (same driver as longcat) |
| `grok-4.6` | — | ✅ via responses driver, incl. tool call |
| `gpt-5.6-luna` | — | ✅ via responses driver |
| `muse-spark-1.3-contributor` | — | ⚠️ privacy privacy-setting blocker |
| `minimax-m3` / `m2.7` | — | ❌ excluded (Anthropic `/messages`) |
| `gpt-5.6-luna` on chat | ❌ protocol unsupported | ✅ via `/responses` |

## Extended entitlement matrix (per-model expectations)

| Model | Zen | Go | pi-swarm behavior now |
| --- | --- | --- | --- |
| `space-bunny-free` | — | free, `/chat/completions` | chat driver, tagged free/unlimited |
| `longcat-2.5-preview-free` | — | free, `/chat/completions` | **verified working**, chat driver |
| `mimo-v2.6-flash` | unknown | paid classification, `/chat/completions` | **verified working** |
| `big-pickle` | free but 403 FreeTierError | `ModelError: not supported` | not routable externally |
| `gpt-5.6-luna` | `/responses` | `/responses` | **verified working** via responses driver |
| `grok-4.6` | `/responses` | `/responses` | **verified working** via responses driver (text + tools) |
| `muse-spark-1.3-contributor` / `1.2` | `/responses` | `/responses` | blocked until OpenCode privacy setting opens; when opened, routes via responses driver |
| `minimax-m3` / `minimax-m2.7` | `/messages` (Anthropic) | `/messages` (Anthropic) | excluded client-side until a `/messages` driver exists |
| `gemini-3.x-flash` / `gemini-3.1-pro` on Zen | native Google endpoint `/models/<id>` | not listed | pi-swarm only speaks chat/responses/messages; missing driver → not routable |
| DeepSeek/Qwen/Hy3 on Go | `/chat/completions` | `/chat/completions` | routable, subject to monthly per-model Go caps |

## Reproducibility

Probes used only public endpoints and an API key already present in
`secrets.env`. Exact shape checks happened against the factory data types in
`src/stream.ts` / `src/stream-responses.ts`; the only pi-swarm code path that
differs from a raw Python probe was adding the declared session header and
model-protocol driver selection.

Run location: `/Users/mobashirrahman/Documents/pi-swarm`,
`secrets.env` (not committed). No provider quotas or response bodies logged.
