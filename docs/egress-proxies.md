# Geo-egress proxies

Route model turns through per-country exits (US, NL, FR, DE, …) so concurrent
agents spread across locations. Every turn picks a **random exit**; failures
are fail-closed — a turn with no matching exit reports `egress_exhausted`
instead of leaking a direct connection.

## What this is (and is not)

- pi-swarm **cannot mint real exit IPs from code**. You bring the exits: a
  commercial VPN converted to local SOCKS5, SSH tunnels, or a residential
  proxy with country selection. The swarm is the rotation + fail-closed layer.
- Exits **do not raise API quotas**. Providers meter by API key, not by IP —
  the quota registry, circuits, and blacklists still apply on top. Rotation
  helps with IP-based throttling, geo-testing, and privacy, not with spending
  more than your keys allow. Do not use it to evade a provider's terms; keys
  caught doing that get banned and the pool learns nothing.
- Proxy failures **never strike providers**: a dead exit is blacklisted for
  30s (then rejoins on its own) and the provider attempt is refunded.

## Configure

```bash
# Inline list (comma/newline separated). Country is optional per entry.
export PI_SWARM_PROXIES="socks5://127.0.0.1:1080#US,socks5://127.0.0.1:1081#NL,socks5://127.0.0.1:1082#FR,socks5://127.0.0.1:1083#DE"

# Or a JSON file (array of strings or {url, country} objects):
export PI_SWARM_PROXIES_FILE=/absolute/path/to/egress-proxies.json
# [{"url":"socks5://127.0.0.1:1080","country":"US"}, "http://user:pass@proxy.example:8080#NL"]

# Optional pool-wide default filter (per-spawn egressCountries overrides it):
export PI_SWARM_EGRESS_COUNTRIES="US,NL,FR,DE"
```

Entry forms (all equivalent for the country tag):

```
socks5://127.0.0.1:1080#US
socks5://127.0.0.1:1080#country=US
socks5://127.0.0.1:1080?country=US
US=socks5://127.0.0.1:1080
https://user:pass@proxy.example:8080
```

Protocols: `http`, `https`, `socks5`/`socks5h` (`socks://` aliases to SOCKS5).
Credentials live only in memory; logs, events, and `swarm_egress` show proxy
ids + redacted `protocol://host:port` + country — never URLs. Put the secrets
file itself in `PI_SWARM_ENV_FILE` and never commit it.

Country filters are fail-closed: requesting `DE` uses only `DE` exits. A
country-less (global) exit never silently substitutes for a requested geo.

## Use

Per agent (`swarm_spawn`, plan subtasks/defaults, HTTP `POST /v1/agents`):

```json
{ "task": "...", "egressCountries": ["US", "DE"], "egressMode": "auto" }
```

- `egressCountries` — ISO-2 filter for this agent. Omit for the pool default.
- `egressMode: "off"` — force a direct connection even when exits exist.
  Default `auto` uses the pool whenever it is configured.

Inspect:

```bash
# MCP
swarm_egress                    # pool, countries, per-exit health
swarm_egress with check:true    # verify each exit (tiny IP-echo, no provider quota)
# HTTP
curl localhost:7463/v1/egress
curl "localhost:7463/v1/egress?check=true"
```

Turn events (`model.changed`) carry `egress` (proxy id) + `egressCountry` —
metadata only, no URLs.

## Getting exits from a commercial VPN

Pick **one** of these; all end at "a SOCKS5/HTTP proxy per country on
localhost", which is what `PI_SWARM_PROXIES` points at.

### Option A — residential proxy with country selection (easiest)

Providers (Bright Data, Decodo, Oxylabs, …) give one HTTP endpoint where the
country rides in the username (`user-country-US:pass@gate:8080`) or a query
param. Paste one entry per country:

```
US=http://user-country-US:pass@gate.provider:8080
DE=http://user-country-DE:pass@gate.provider:8080
```

No local daemons, no WireGuard juggling. This is the recommended path unless
you specifically need VPN-owned IPs.

### Option B — VPN app + local SOCKS5 per tunnel (self-hosted)

1. In Mullvad/ProtonVPN create one WireGuard key per country (US, NL, FR, DE)
   and download the four `.conf` files.
2. Bring each tunnel up on its own interface/table, e.g.
   `wg-quick up us.conf`, then expose a SOCKS5 bound to that interface. One
   lightweight way per country:
   `gost -L socks5://127.0.0.1:1080 -F ...` or `3proxy`/tinyproxy bound to
   the tunnel interface (see their docs for interface binding).
3. Point the pool at them:
   `PI_SWARM_PROXIES="socks5://127.0.0.1:1080#US,..."`.

Keep the VPN kill-switch on so a dropped tunnel fails (blacklisted exit,
turn reroutes) rather than leaking direct traffic from the host.

### Option C — SSH tunnels (you own VPSs per country)

```
ssh -N -D 127.0.0.1:1080 user@vps-us &
ssh -N -D 127.0.0.1:1081 user@vps-nl &
```

Same `PI_SWARM_PROXIES` shape as option B. Add `-o ExitOnForwardFailure=yes`
+ autossh/systemd so a dead tunnel restarts instead of blackholing.

## Verify

1. `swarm_egress` — exits listed with countries.
2. `swarm_egress` with `check:true` — each exit fetches an IP-echo endpoint
   and reports the visible exit IP + latency (no provider quota spent).
3. Spawn with `egressCountries: ["DE"]`, then `swarm_status` — the
   `model.changed` event shows `egressCountry: "DE"`.
4. Stop one proxy and re-spawn — the turn reroutes to another exit and the
   dead one shows `blacklisted: true` for ~30s, while provider circuits stay
   `closed`.

## Failure reasons

| Reason | Meaning |
| --- | --- |
| `egress_exhausted` | Pool empty, no exit matches the country filter, or every exit is temporarily blacklisted. Add exits or widen the filter — the turn never falls back to direct. |
| exit `blacklisted` | That exit failed recently; rejoins automatically after ~30s. |
| `no_country_match` (log) | The filter names a country with no exit configured. |
