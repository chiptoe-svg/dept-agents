# Agent Egress Control — Proxy Allowlist + fetch_url Guard — Design Spec

**Date:** 2026-06-10
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Stop a prompt-injected agent from (a) using the org's real LLM/Google credentials against arbitrary upstream API endpoints via the credential proxy, and (b) reaching internal services through the `fetch_url` tool. Scope is the **proxy and application layers only** — network-layer egress control (the complete fix that would also catch `bash`+`curl`) is explicitly deferred.

## Background (verified live, 2026-06-10)

The Apple `container` agents reach the host at the bridge gateway `192.168.64.1` (see `state.md`, the SearXNG work). A throwaway agent container was used to probe reachability from inside the sandbox:

| Target | Result | Meaning |
|---|---|---|
| `192.168.64.1:3001/openai/v1/models` | **200** | Agent listed OpenAI models **using the org's real key**, via the proxy, from a plain `curl`. |
| `192.168.64.1:3001/v1/models` (anthropic route) | 401 | Anthropic route reachable; this GET rejected (needs other headers). |
| `192.168.64.1:3007` (GWS relay) | 404 | Reachable. |
| `192.168.64.1:8888` (SearXNG) | 200 | Reachable (expected — `web_search`). |
| `130.127.162.180:3003` (webhook) | 404 | Reachable on the Clemson LAN IP. |
| `130.127.162.180:3002` (playground) | conn-fail | Loopback-bound; not reachable. |
| `169.254.169.254` (cloud metadata) | conn-fail | N/A on this Mac Studio (block for portability). |
| `https://example.com` | 200 | Full internet egress, unrestricted. |

Confirmed facts that shape the design:

- **`fetch_url` is ours** (`container/agent-runner/src/tools/fetch.ts`) and has **zero URL validation** — it `fetch()`es any string with `redirect: 'follow'`, and the `MAX_REDIRECTS` const is declared but never used.
- The agent has a **`bash` tool** (from `@earendil-works/pi-coding-agent`'s `createCodingTools()`), and the image ships `curl` + `chromium`. So `fetch_url` hardening alone is **defense-in-depth**, not a real control — the real control for the bash path is network-layer (out of scope here).
- The **credential proxy** (`src/credential-proxy.ts`) **pins the upstream host** by path-prefix route (`/openai/*`→OpenAI, `/googleapis/*`→`www.googleapis.com`, `/omlx/*`, `/clemson/*`, default→Anthropic), reading the host from `.env` secrets — so an agent **cannot** redirect injected creds to an attacker host. But it does **not** restrict the upstream **path/method**, so any endpoint on the pinned host is callable with the real injected credential (the `/openai/v1/models` 200 proves it). Credential injection happens at `credential-proxy.ts` ~line 542–561 (`x-api-key` / `Authorization: Bearer`).
- **`/v1/models` is never called by the harness** — pi takes `model.contextWindow` from the model catalog (`pi.ts` ~line 404), not a live `/v1/models` call. Allowlisting it out is safe.
- The **`/googleapis/` route is used by the host-side GWS relay** (`src/gws-mcp-tools.ts` via `@googleapis/{drive,calendar,gmail,sheets,slides}`), **not** by the container. The container reaches Google through the relay at `gateway:3007` (`GWS_MCP_RELAY_URL`). But the container *can* reach `gateway:3001/googleapis/*` directly — the Google-OAuth abuse vector.
- The proxy can see the request source via `req.socket.remoteAddress`: container = `192.168.64.x`, host relay = loopback/host. (To be verified in implementation.)

## Architecture

Three components, all **fail-closed**.

### Component 1 — Credential-proxy per-route path allowlist (primary control)

In `src/credential-proxy.ts`, after the route is determined and the prefix stripped (the `upstreamPath` computation, ~line 476–486) and **before** credential injection/forwarding, check `(method, upstreamPath)` against a per-route allowlist constant. On no-match: respond **403** with `{ "error": "endpoint not allowed by nanoclaw egress policy" }`, attach **no** credentials, do not forward, and emit a host audit log line. Hardcoded constant (no config knob — YAGNI).

Allowlist (path match is exact or a documented prefix; method pinned to `POST` for LLM routes):

| Route (internal id) | Allowed (method + path) |
|---|---|
| `anthropic` (default) | `POST /v1/messages`; `POST /v1/messages/count_tokens` **only if** the SDK is confirmed to call it (verify in impl; omit otherwise) |
| `openai` / `openai-platform` | `POST /v1/responses`, `POST /v1/chat/completions` |
| `omlx` | `POST /v1/chat/completions`, `POST /v1/responses` |
| `clemson` | `POST /v1/chat/completions`, `POST /v1/responses` |
| `googleapis` | prefix-allow the GWS surfaces the relay uses: `gmail/v1/`, `calendar/v3/`, `drive/v3/`, `sheets/v4/`, `slides/v1/`, `oauth2/v2/userinfo` (enumerate precisely from the `@googleapis/*` calls in impl) |

This closes the proven finding: `/openai/v1/models` (and all other non-chat endpoints) → 403.

### Component 2 — Source-fence the Google route

The Component 1 allowlist still permits an agent to ride the Google OAuth token *within* the allowlisted Google paths. Since the container's only legitimate proxy use is the LLM routes, **reject `/googleapis/*` requests whose source is the container bridge subnet `192.168.64.0/24`**, allowing only loopback/host (the relay). This closes the agent→Google-OAuth vector.

Implementation must **verify the relay actually calls the proxy from loopback** (`127.0.0.1`). If it does not (e.g., it calls via the gateway IP indistinguishable from a container), fall back to: keep the Component 1 Google path allowlist and document the residual risk, or introduce a relay-scoped marker the container can't forge. Do not ship a source-fence that also blocks the legitimate relay.

### Component 3 — `fetch_url` egress guard (defense-in-depth)

In `container/agent-runner/src/tools/fetch.ts`, before fetching:

1. Parse the URL; reject any scheme other than `http`/`https`.
2. Resolve the hostname to IP(s); reject if **any** resolved address is loopback (`127.0.0.0/8`, `::1`), RFC-1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254.0.0/16`, incl. cloud metadata `169.254.169.254`), CGNAT (`100.64.0.0/10`), or the bridge gateway IP.
3. **Re-validate on every redirect hop** — replace `redirect: 'follow'` with manual redirect handling bounded by `MAX_REDIRECTS` (currently dead code), re-running steps 1–2 on each `Location` so a `302 → http://192.168.64.1:3001` cannot bounce inside.
4. **Fail-closed on DNS resolution failure** (refuse rather than fetch).

On rejection: return a clear agent-facing message (`"blocked by egress policy: <reason>"`) as the tool result; do not throw.

This is bypassable via `bash`/`curl`/`chromium` — acknowledged; closes the no-effort `fetch_url` path and matches Hermes' posture.

## Failure semantics

All three components fail closed. Rejections return a clear, non-leaky message to the agent and emit a host-side audit log line (route/path/source/decision for the proxy; url/reason for fetch_url) so probing attempts are detectable and we have a trail.

## Testing

**Host (`vitest`, `src/credential-proxy.test.ts` or a new test):**
- Allowlisted `(method, path)` per route → forwarded (creds injected, upstream reached via a mock).
- `/v1/models`, `/v1/files`, arbitrary paths, and wrong method on every route → **403, no credential header attached** (assert the injected `x-api-key`/`Authorization` is absent on the rejected path).
- `/googleapis/*` from a `192.168.64.x` source → 403; from loopback → allowed (mock `remoteAddress`).

**Agent-runner (`bun test`, `container/agent-runner/src/tools/fetch.test.ts`):**
- Rejects `http://192.168.64.1:3001`, `http://127.0.0.1:x`, `http://10.x`, `http://169.254.169.254`, `file://…`, and the gateway IP.
- Re-validates redirects: a mocked `302 → internal IP` is blocked.
- Fail-closed on DNS resolution failure.
- Allows a normal external `https://` URL (mocked fetch).

**Live re-probe (this install):** re-run the container SSRF probe — `/openai/v1/models` → **403**; a real agent turn still produces an LLM response (legit `/v1/responses` or `/v1/messages` path works); a real `web_search` + `fetch_url` of an external page still works; GWS tool still works through the relay.

Build clean (`pnpm run build` + agent-runner `bun run typecheck`) + full suites green.

## Boundaries (out of scope)

- **Network-layer egress control** — `bash`/`curl`/`chromium` reaching SearXNG/relay/LAN/internet, and data exfiltration to arbitrary external hosts. Deferred (the "full network egress policy" approach we declined for now).
- SearXNG (`8888`) and the GWS relay (`3007`) remain reachable from the container by design.
- Restricting general internet egress (agents legitimately need the web).
- Per-agent budgets / cost governance, prompt-injection scanning of fetched content (separate blind-spots, separate specs).

## Risks / notes

- **Allowlist too tight breaks real traffic.** Mitigated by grounding paths in verified harness/SDK behavior and by the live re-probe gate. The riskiest entries are `count_tokens` (verify before including/excluding) and the exact Google path prefixes.
- **Source-fence depends on the relay's source address.** Verify in implementation; have the documented fallback ready.
- **No container rebuild needed for the proxy change** (host-side; restart host). The `fetch_url` change is agent-runner source — picked up via the runtime RO mount on next container spawn (no image rebuild; see `state.md` decision log).
- **Defense-in-depth, not a wall.** This does not stop a determined prompt-injected agent with `bash`. It removes the credential-misuse vector (the proven, highest-severity finding) and the trivial `fetch_url` path. The network-layer follow-up remains the complete control.

## Suggested phasing (for the plan)

1. `fetch_url` egress guard + redirect re-validation + tests (self-contained, agent-runner).
2. Credential-proxy per-route path allowlist + tests (host).
3. Source-fence `/googleapis` (after verifying the relay's source) + tests.
4. Build + full suites + live re-probe + `state.md` decision-log entry.
