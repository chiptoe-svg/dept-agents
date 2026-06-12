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

### Component 1 — Explicit-prefix routing with no provider catch-all (fail-closed default)

Today the proxy routes unrecognized/unprefixed paths to Anthropic (the `else → anthropicUpstream` fallback, `credential-proxy.ts` ~line 475), because the Anthropic SDK is pointed at the proxy with a *bare* base URL (`ANTHROPIC_BASE_URL=http://gateway:3001`, no prefix). This permissive catch-all hands out credentials for any unrecognized path and privileges one provider. **Remove it.** Every provider gets an explicit prefix; the bare/unrecognized route fails closed.

- **Add an `/anthropic` route** to the proxy (parallel to `/openai`, `/omlx`, `/clemson`, `/googleapis`): match `/anthropic/*`, strip the prefix, forward to `anthropicUpstream`. Update the credential-resolution branch (`credential-proxy.ts` ~line 542, currently keyed on `!isGoogle && !isOmlx && !isClemson`) to key on the explicit `isAnthropic` instead.
- **Change `container-runner.ts`** `buildContainerArgs` to set `ANTHROPIC_BASE_URL=http://${gateway}:${port}/anthropic` (was bare). The Anthropic SDK then posts to `/anthropic/v1/messages`; the proxy strips `/anthropic` → `/v1/messages`.
- **Bare path / unrecognized prefix → 403, fail-closed, no creds.** There is no provider catch-all.

**OAuth-landmine interaction (verify in impl):** one of the four Anthropic OAuth landmines is the `model.baseUrl` override (`pi.ts`), which is set from `ANTHROPIC_BASE_URL`. With the `/anthropic` prefix it becomes `…/anthropic`; confirm the SDK appends `/v1/messages` correctly and the proxy's prefix-strip + the preamble/beta-header handling all still produce a valid upstream call. This box has no Anthropic creds/agents so it can't be live-verified here — verify on a path that exercises the strip (unit test) and flag for the next Anthropic-using install.

Then, after the route is determined and the prefix stripped (the `upstreamPath` computation, ~line 476–486) and **before** credential injection/forwarding, check `(method, upstreamPath)` against a per-route allowlist constant. On no-match: respond **403** with `{ "error": "endpoint not allowed by nanoclaw egress policy" }`, attach **no** credentials, do not forward, and emit a host audit log line. Hardcoded constant (no config knob — YAGNI).

Allowlist (path match is exact or a documented prefix; method pinned to `POST` for LLM routes):

| Route (internal id) | Reached via | Allowed (method + path) |
|---|---|---|
| `anthropic` | `/anthropic/*` prefix | `POST /v1/messages`; `POST /api/oauth/claude_cli/create_api_key` (REQUIRED — the OAuth-mode token→temp-key exchange the proxy injects on; blocking it breaks OAuth-mode installs). (`count_tokens` confirmed unused — omitted.) |
| `openai` / `openai-platform` | `/openai/*`, `/openai-platform/*` | `POST /v1/responses`, `POST /v1/chat/completions` |
| `omlx` | `/omlx/*` | `POST /v1/chat/completions`, `POST /v1/responses` |
| `clemson` | `/clemson/*` | `POST /v1/chat/completions`, `POST /v1/responses` |
| `googleapis` | `/googleapis/*` | **nothing — empty allowlist → 403** (route is dead; see Component 2) |
| _(none)_ | bare path / unrecognized prefix | **nothing — 403 fail-closed, no creds** |

This closes the proven finding (`/openai/v1/models` → 403) **and** removes the permissive Anthropic catch-all.

### Component 2 — Fail the `/googleapis` route closed (it has no legitimate caller)

Verified during planning (2026-06-10): the proxy's `/googleapis` route is **dead** in the current architecture. The container reaches Google Workspace via the **GWS relay on `:3007`** (`container/agent-runner/src/mcp-tools/gws.ts`), and the relay (`src/gws-mcp-tools.ts`) resolves the OAuth token host-side (`getGoogleAccessTokenForAgentGroup`) and sets it **directly** on the `@googleapis/*` clients — which call Google's own hosts (`www.googleapis.com`, `gmail.googleapis.com`, …) directly, **never through the proxy**. Host logs show zero `/googleapis` route activity. So the route is purely a dormant capability (a per-student-GWS-through-proxy idea) and, right now, only an **agent→Google-OAuth egress hole**.

Therefore: **give `/googleapis` an empty allowlist → every request to it returns 403, no token injected.** Simpler and strictly stronger than a source-fence (no relay-source assumption, no residual). The `isGoogle` token-injection block (`credential-proxy.ts` ~line 571–590) becomes unreachable; leave it in place with a one-line comment noting it's gated off pending a future per-student GWS-through-proxy design (do not delete — pre-existing infra, out of scope). If that future design lands, it re-enables `/googleapis` with its own controls.

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
- `/anthropic/v1/messages` routes to the anthropic upstream with the prefix stripped (and gets the anthropic cred).
- Bare path (`/v1/messages`, `/`) and unrecognized prefix (`/foo/…`) → **403, no creds, not forwarded** (the catch-all is gone).
- Allowlisted `(method, path)` per route → forwarded (creds injected, upstream reached via a mock).
- `/openai/v1/models`, `/v1/files`, arbitrary paths, and wrong method on every route → **403, no credential header attached** (assert the injected `x-api-key`/`Authorization` is absent on the rejected path).
- `/googleapis/*` (any source, any path) → 403, no Google token injected (empty allowlist).

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
- **No container rebuild needed for the proxy change** (host-side; restart host). The `fetch_url` change is agent-runner source — picked up via the runtime RO mount on next container spawn (no image rebuild; see `state.md` decision log).
- **The `/anthropic`-prefix change is trunk and atomic-deploy-sensitive.** `container-runner.ts` (sets the new base URL at spawn) and `credential-proxy.ts` (strips the new prefix) must update together; a host restart does both in one process, and new spawns pick up the new env. Existing running containers spawned before the restart still carry the bare `ANTHROPIC_BASE_URL` and would 403 against the new proxy — on this box that's moot (no Anthropic agents), but for an Anthropic-using install the restart should respawn/let sessions re-spawn. Flag this in the `update-nanoclaw` path so other installs don't get a half-applied routing change.
- **The `/anthropic` routing change affects every install, including Anthropic-primary ones (personal).** It's verified by unit test on this box (no live Anthropic creds); the next Anthropic-using install must live-verify a real Claude turn after deploy.
- **Source-fence depends on the relay's source address.** Verify in implementation; have the documented fallback ready.
- **Defense-in-depth, not a wall.** This does not stop a determined prompt-injected agent with `bash`. It removes the credential-misuse vector (the proven, highest-severity finding) and the trivial `fetch_url` path. The network-layer follow-up remains the complete control.

## Suggested phasing (for the plan)

1. `fetch_url` egress guard + redirect re-validation + tests (self-contained, agent-runner).
2. Explicit-prefix routing: add the `/anthropic` proxy route + strip, switch `container-runner.ts` `ANTHROPIC_BASE_URL` to the `/anthropic` prefix, drop the catch-all so bare/unrecognized → 403 + tests (host). Verify the OAuth-landmine base-URL handling via unit test.
3. Credential-proxy per-route path allowlist (incl. fail-closed default) + tests (host).
   (Includes `/googleapis` → empty allowlist → 403; the dormant route is fenced off.)
4. Build + full suites + live re-probe + `state.md` decision-log entry.
