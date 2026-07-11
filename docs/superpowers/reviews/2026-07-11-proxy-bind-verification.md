# Proxy / GWS-relay bind hardening — live verification

**Date:** 2026-07-11. Proxy-bind-hardening plan, Task 3. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, box `130.127.162.67`, playground at `http://gcworkflow.clemson.edu:8088`).

## Result: PASS — the two credential-bearing services are off the campus network; the container + loopback paths still work.

## 1. Bind addresses: wildcard gone, loopback + gateway present

**Before** (running the old code, `CREDENTIAL_PROXY_HOST=0.0.0.0`):

```
:3001  node  TCP *:3001 (LISTEN)
:3007  node  TCP *:3007 (LISTEN)
```

**After** (rebuilt + `launchctl kickstart -k … com.nanoclaw-v2-581fefa4`, `CREDENTIAL_PROXY_HOST=127.0.0.1`):

```
:3001  node  TCP 127.0.0.1:3001 (LISTEN)
       node  TCP 192.168.65.1:3001 (LISTEN)
:3007  node  TCP 127.0.0.1:3007 (LISTEN)
       node  TCP 192.168.65.1:3007 (LISTEN)
```

No `*:` (wildcard) listener remains on either port. The deliberately out-of-scope webhook stays `*:3003` (unchanged, as intended). Startup log confirms the dual-bind and that the gateway bind succeeded on the first attempt (bridge already up, no retry):

```
INFO Credential proxy listening  host="127.0.0.1"    port=3001
INFO Credential proxy listening  host="192.168.65.1" port=3001
INFO GWS MCP relay listening      host="127.0.0.1"    port=3007
INFO GWS MCP relay listening      host="192.168.65.1" port=3007
```

No `EADDR*`/bind errors at startup.

## 2. Campus can no longer reach the services; loopback + gateway can

`curl --max-time 4` from the host:

| Target | Result | Meaning |
|--------|--------|---------|
| `http://127.0.0.1:3001/` | HTTP 403 | connects — proxy egress gate responds (host direct-chat path intact) |
| `http://192.168.65.1:3001/` | HTTP 403 | connects — container path intact |
| `http://130.127.162.67:3001/` (campus IP) | curl exit 7 (connection refused) | **campus can no longer reach the credential proxy** |
| `http://130.127.162.67:3007/` (campus IP) | curl exit 7 (connection refused) | **campus can no longer reach the GWS relay** |

Before the change, the campus-IP requests would have connected (the service was bound to `0.0.0.0`). The `403`s are the proxy's own egress gate rejecting a bare `/` (an unrecognized route); the host log shows both as `credential-proxy: egress blocked (unrecognized route)` with `src="127.0.0.1"` and `src="192.168.65.1"` — confirming both curls reached the proxy.

## 3. A real container turn still works end-to-end (the gateway credential path)

Drove one live turn as the owner (`playground:owner_01`) through the real HTTP path (`POST /api/drafts/owner_01/messages`, session cookie), asking the agent to reply with a single sentinel word:

- The router logged `Message routed … wake=true` and spawned container `nanoclaw-v2-owner_01-1783757163304` (container IP `192.168.65.17`).
- The agent replied (session `outbound`, read via `GET /api/drafts/owner_01/recent`):
  - `seq 797`, `2026-07-11 08:06:06`, text **`BINDCHECK`** (exactly the requested word), `provider: "anthropic"`, `model: "claude-haiku-4-5"`, `tokensIn: 3`, `tokensOut: 19`.

The container at `192.168.65.17` reached the credential proxy at the bridge gateway `192.168.65.1:3001`, the proxy substituted the real Anthropic OAuth credential (`authMode=oauth`), forwarded to Anthropic, and the reply came back — the full credential-substitution path is unaffected by the bind change.

## Standing state

- `.env` `CREDENTIAL_PROXY_HOST=127.0.0.1` (out-of-tree; the code adds the bridge gateway via `CONTAINER_HOST_GATEWAY()` and never binds a wildcard — a stale `0.0.0.0` here would be coerced to loopback with a warning).
- The webhook `:3003` remains on `0.0.0.0` by design (may need inbound platform webhooks); revisit separately if it should be fronted by Caddy or bound narrower.
- Operator note: the owner login token was rotated during this test (twice), invalidating any previously-bookmarked owner login URL. A fresh URL was minted and handed to the owner to re-bookmark.
