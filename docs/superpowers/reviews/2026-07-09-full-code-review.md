# Full Code Review — 2026-07-09

**Scope:** whole repo, at `a565f0d2` (post-Plan-1 department-server base).
**Method:** six parallel dimension reviewers (host isolation, container isolation, security, correctness, architecture, performance), then adversarial verification of every Critical/High finding by separate agents instructed to *refute* them. Findings below survived that. Two facts were closed by the controller directly (`checkDraftMutation` semantics; live `env`/`mcp_servers` contents).
**Verification status is stated per finding.** Nothing here is speculation; unverified hunches are in the last section.

---

## Headline

**Per-user isolation does not hold today.** The requirement — *"one user's secrets, conversations, and results stay separate unless deliberately shared"* — is not currently enforced by the code. This is not a collection of unrelated bugs; it is **one design defect repeated in three subsystems**:

> **Identity is asserted by a value the caller supplies, and never bound server-side to who the caller actually is.**

- Web API: the target agent group comes from the **URL path**, and most mutation routes never check it against the session.
- Credential proxy (`:3001`): the agent group comes from the **`x-nanoclaw-agent-group` request header**, unauthenticated.
- GWS MCP relay (`:3007`): same header, same trust.

**Nothing is currently being exploited**, because the deployment has exactly three agent groups (all the owner's own: `owner_01`, `user_01`, `_default_participant`), no second human user, no Google credentials on the box, and empty `env`/`mcp_servers`. The defects are latent *by deployment state, not by control*. **They arm the moment the first colleague is invited** — which is precisely what Plan 3 does.

**Recommendation: do not invite any pilot user until the Critical items below are fixed.** They are a well-bounded piece of work (a shared authorization helper + two identity bindings), not a redesign.

---

## Critical — cross-tenant compromise via the web API

All are **exploitable now** given a second authenticated user, and require nothing but a normal session and a guessable folder name (`user_01`, `user_02`, … are enumerable). Auth bypass being on today masks these; turning it off (Plan 3) does *not* fix them, because the gap is per-object authorization, not authentication.

### C1. `PUT /api/drafts/:folder/persona` has no authorization check at all
`src/channels/playground/api-routes.ts:359-386`

One request rewrites **any** other user's `CLAUDE.local.md` (their agent's system prompt) and then kills their running container to force a respawn (`killContainer`, `:375`). The victim's agent thereafter follows the attacker's instructions, with the victim's credentials, workspace, tools, and memory.

The tell that this is an oversight rather than a design: **`GET` on the identical regex is gated** (`:341`, `canReadDraft`); the `PUT` immediately below it is not. *(Verified directly by the controller: read both blocks.)*

### C2. `POST /api/drafts/:folder/messages` has no authorization check
`src/channels/playground/api-routes.ts:228-335`

Injects an arbitrary message into another user's agent group, dispatched with `isMention: true` (`:327`) so the victim's container always engages. The in-code comment at `:215-220` asserts membership "is enforced in `getPlaygroundAgentForUser` at sign-in time" — **that claim is false**: sign-in selects the caller's *own* group; it does not constrain the `:folder` in this URL. A comment documenting a gate that doesn't exist is how this survived. *(Verified; refutation attempted and failed.)*

### C3. `checkDraftMutation` is not an authorization check — and ~12 mutation routes rely on it as one
`src/channels/playground-gate-registry.ts:65-79`

It **default-allows** (`return { allow: true }` on an empty gate chain — controller-verified), and returns `{allow:true}` outright when `PLAYGROUND_AUTH_BYPASS` is set. Its only registered gate (`src/class-playground-gate.ts:47`) fires *only* for `draft_`-prefixed folders, so for the direct `user_NN` folders the live UI actually uses, **it no-ops**.

Every route "protected" only by it is cross-tenant writable: `PUT .../skills`, `PUT .../custom-skills/:name/file` (arbitrary file write into another user's skill dir), `DELETE .../custom-skills/:name`, `PUT .../models`, `PUT .../active-model` (flip another user's provider/model), `PUT .../name`, and the whole `knowledge/corpora` mutation family (`api-routes.ts:555, 605, 630, 646, 659, 684, 1044, 1066, 1085, 1110`).

### C4. Ungated draft create / apply
`src/channels/playground/api-routes.ts:176-213`

`createDraft(targetFolder)` snapshots any group; `applyDraft` writes persona + `container.json` onto the target. **Corrections to the original finding:** `DELETE` is `draft_`-only (destroys drafts, not live groups), and `createDraft` alone is not a read primitive (reading the new draft back is blocked by `canReadDraft`). C1 is the cleaner persona-hijack path.

**Single correct fix for C1–C4:** apply a real ownership check — `canAccessAgentGroup` (member level), as `canReadDraft` already does — to **every** mutation route, and stop treating `checkDraftMutation` as authorization. A route table with an explicit gate column, tested, would prevent regression: the current pattern silently fails open when someone adds a route.

---

## Critical / High — identity spoofing at the host service boundary

### C5. Credential proxy: unauthenticated, listens on all interfaces, trusts a header for identity
`src/credential-proxy.ts:171, 540-541, 608-615, 464`

- **Binds `0.0.0.0:3001`** — controller-verified live: `lsof` → `node … TCP *:3001 (LISTEN)`. (The function default is `127.0.0.1`; a caller passes `0.0.0.0` deliberately, because Apple Container guests must reach the host across the bridge.)
- **No authentication of any kind** — no shared secret, no per-container token, no source binding. The only control is the egress allowlist, which restricts *which upstream*, not *who calls*.
- **Attribution is the client-supplied `x-nanoclaw-agent-group` header** (`:540`), passed straight to `userCredsHook(agentGroupId, providerId)` (`:615` → `src/user-provider-resolver.ts:165-206`), which returns **that group's** real API key / refreshed OAuth token and injects it upstream.
- **Fails open, not closed:** an absent/unknown header falls back to the department `.env` credentials.
- **macOS firewall is off** (controller-verified: `socketfilterfw --getglobalstate` → disabled).

Two impacts: (a) **cross-user credential misuse** — a compromised or prompt-injected agent spends a *specific colleague's* ChatGPT quota and acts under their OAuth authorization (the token is used, not returned, so this is impersonation rather than key exfiltration); (b) **open credential proxy** — anything on the campus network reachable to `:3001` can burn the department OpenAI key with no header at all.

Specific-victim targeting needs the victim's random `ag_<hex>` group id — **which C6 hands over.**

*A live end-to-end confirmation (spoofed-header request from the external interface) was **not run**: a safety classifier blocked it and it was not worked around. The static evidence above is direct. Owner can confirm in one command from another campus machine — see `.superpowers/review/controller-finding-proxy.md`.*

### C6. `ncl` reads run at host authority from inside any container, unscoped
`src/cli/dispatch.ts:21`, `src/cli/crud.ts:101-132`, `src/cli/resources/groups.ts:75, 206-216`

Every `list`/`get` verb is `access: 'open'`, and `genericList`/`genericGet` have **no caller scoping** — a `--id` argument targets any row. The host *does* correctly stamp the calling group (`src/cli/delivery-action.ts:29-32`, not forgeable) — but nothing uses it to scope reads.

So any container can run `ncl groups list` (→ **every group's id and folder**), `ncl users list`, `messaging-groups list`, `sessions list`, `user-dms list` (→ every tenant's handles, phone numbers, emails). `groups config-get --id <any>` returns that group's `env` + `mcp_servers`.

**Exploitable now** for cross-tenant metadata disclosure and — critically — **as the discovery primitive that arms C5 and C7.** Secret theft via `config-get` is *not* live: controller verified all three groups have `env = {}` and `mcp_servers = {}`. That is a data accident, not a control.

`cli_scope` (migration `018-cli-scope.ts`, default `'group'`) is stored, displayed, and settable — **and never read to gate anything.** A designed control that was never wired.

### C7. GWS MCP relay (`:3007`) authenticates by the same spoofable header
`src/gws-mcp-relay.ts:81-105`, `src/gws-token.ts:207-219`

Checks only that the header is present and names an existing group, then dispatches with `ctx.agentGroupId` set from it. **No `canAccessAgentGroup` anywhere on the path** — despite `container/agent-runner/src/mcp-tools/gws.ts:8` claiming "applies role-based scoping (`canAccessAgentGroup`)". That comment is false.

**Currently latent — verified inert:** there are no Google credentials on this box (`data/student-google-auth/` empty, `~/.config/gws/credentials.json` absent), so every GWS tool fails at token resolution. It becomes live the instant any faculty member completes "Connect Google." Note the fallback asymmetry: Gmail/Calendar require a personal token; **Drive/Sheets/Slides fall back to the instructor/owner token**, which is arguably worse.

### C8. No container network isolation (the enabler)
`src/container-runner.ts` `buildContainerArgs` — no `--network` restriction

All containers share one bridge and can reach host services on the gateway (`:3001` proxy, `:3007` relay), peer containers, and the LAN. The `fetch_url` tool's SSRF guard is solid, **but the agent also has a shell**, so `curl` bypasses it entirely. This is what turns C5/C6/C7 from theory into a chain.

### The realistic attack chain (all links verified in code; step 4 blocked only by absent credentials)

1. Colleague A's agent reads an attacker-controlled web page → prompt injection.
2. Agent runs `ncl groups list` → learns colleague B's `ag_<hex>` id. **(C6)**
3. Agent `curl`s `http://<gateway>:3007/tools/gmail_search -H 'x-nanoclaw-agent-group: <B's id>'`. **(C7 + C8)**
4. Relay resolves **B's** Google OAuth token and reads B's inbox.

Substitute `:3001` at step 3 and the same chain spends B's ChatGPT quota instead — and *that* variant has no missing link.

---

## High — money and availability

| # | Finding | Where | Status |
|---|---|---|---|
| H1 | **`/api/direct-chat` has no spend control**; the `model` parameter is never checked against the allowlist, and `agentFolder` is optional so `canReadDraft` is skipped entirely. Any signed-in user loops it on an arbitrary expensive model and drains the department key. | `api/direct-chat.ts:284`, `api-routes.ts:774,780` | exploitable-now |
| H2 | **Cost budgets are display-only.** `evaluateBudget` / `budgetForAgent` have zero callers outside the UI handler — a configured "$ cap" enforces nothing. A runaway agent or bad scheduled task blows past it silently. | `api/cost-budgets.ts:81-131` | confirmed |
| H3 | **Pi errors never reach the user, and continuation recovery is dead code.** Pi pushes `{type:'error'}` events rather than throwing; the poll loop only logs them. Any API failure = silent no-reply on non-playground channels, the message is marked *completed*, and a corrupt continuation is never cleared → **the session is permanently dead until someone manually clears it.** | `providers/pi.ts:543-560`, `poll-loop.ts:522-546` | confirmed |
| H4 | **Follow-ups are acked `completed` at push time**, before the model processes them. A crash/kill mid-turn permanently drops the user's follow-up — completed acks are unrecoverable. | `poll-loop.ts:398-402` | confirmed |
| H5 | **`writeOutboundDirect` violates two documented invariants**: writes an even `seq` into the odd-only `messages_out` (breaking seq-routed edit targeting) and opens `outbound.db` read-write while the container may be writing (cross-kernel dual writer). Zero tests. | `session-manager.ts:438-462` via `router.ts:437` | confirmed (parity); suspected (corruption) |
| H6 | **`.env` is mode 0644** — every provider key world-readable to any local account, defeating the credential proxy at the filesystem layer. | `.env` | exploitable-now on a shared box |

---

## Medium

- **Magic-link tokens are replayable for a full hour** and travel in the URL (browser history, Referer, proxy logs); the cookie lacks `Secure`. The code comment claiming "single-use, 5-min" is false. `auth-store.ts:35,105,133`
- **`/var/www/sites` is one shared read-write mount** in every container — group A can read, overwrite, or deface group B's generated site files, which are also served publicly. `container-runner.ts:381-388`
- **Delivery: 3 retries at 1s, no backoff.** A ~3s Telegram 429 permanently drops the agent's reply, surfaced nowhere. `delivery.ts:32,218-254`
- **Wake-then-kill self-race** in host-sweep: after a crash, step 2 spawns a container and step 3 kills it on the same tick. `host-sweep.ts:182-203`
- **Recurrence is not transactional** (`insertRecurrence` + `clearRecurrence`): a crash between them duplicates a recurring task **forever**. `scheduling/recurrence.ts:36-37`
- **Recurring series dies silently** at MAX_TRIES; **unvalidated cron** is accepted, then throws on every sweep forever. `scheduling/db.ts:122`, `scheduling.ts:75`
- **`container_status` is never reconciled at startup** → after a host crash, sessions are `'running'` forever.
- **Backlog >10 messages processed newest-first**, 10 per 60s tick. `messages-in.ts:75-98`
- **PIN-issue email bomb**: a valid-token holder triggers unlimited PIN emails to a user, no throttle. `api/login-pin.ts:54`
- **Root-caused (previously "known, non-fatal"):** the `attempt to write a readonly database` noise is `SQLITE_READONLY_ROLLBACK` on the container's *read-only* `inbound.db` reads — the host's DELETE-journal commits leave a hot journal and virtiofs doesn't propagate SQLite locks across kernels. `withReadonlyRetry` guards only outbound *writes*. Fix: wrap the inbound read.

---

## Performance (ranked by expected saving)

- **Pi never rotates its on-disk session transcript.** The provider-agnostic hook exists (`poll-loop.ts:86-97`); pi — the only active provider — doesn't implement it. Every cold resume (30-min idle kill, crash, restart) re-reads and re-parses the *entire* history. Cost rises monotonically over a semester. **Effort: M. This is the biggest real-money item.**
- **Usage aggregation rescans everything.** `aggregateAgentUsage` re-reads and `JSON.parse`s every historical message of every session of every group, from scratch, on a 30s Status-tab poll. Free today (2 rows); unbounded with real use. Cache ~25s (S) or keep an incremental aggregate (M). `api/usage.ts:71-149`
- **`PRAGMA table_info` schema check on every DB open** — ~15×/sec system-wide at 15 sessions, forever. Cache per session id. **Effort: S.** `db/session-db.ts:319,334`
- **Containers default to 4 vCPU each** (verified live) → 15 concurrent = 60 vCPU committed against 16 physical cores. Set `--cpus 2 --memory 1024`. **Effort: S.**
- **No index on `messages_in.status`** (every poll filters on it) and **no retention policy** on `messages_in`/`messages_out`. Harmless at today's row counts; compounding.
- **Dead weight:** `@anthropic-ai/claude-code` is still installed in the image with zero references since Phase D.

**Verified efficient (don't "fix"):** prompt caching is correctly wired; the system prompt is computed once per container lifetime, not per turn; skills lazy-load as name+description only; auto-compaction at 70%; no leaking in-memory maps; no sync I/O in hot paths; chat uses SSE, not polling; Dockerfile layering is already cache-optimal.

---

## Architecture & methodology

**Invariant violations** (the repo documents these invariants; the code breaks them):
- `writeOutboundDirect` — seq parity + single-writer (H5 above).
- `api/direct-chat.ts:95-120` hand-rolls a pseudo-session `outbound.db` with a raw `new Database()` and a **second, divergent `messages_out` schema**, invisible to stale-journal recovery.
- `delivery.ts:298-308` dynamic-imports playground SSE from trunk, bypassing destination permission checks — a trunk→channel side door.
- The ChatGPT-OAuth path contradicts the documented "no real tokens in containers" invariant: real tokens live in the mounted `pi-auth/auth.json`, and `pi-auth.ts:116` egresses to chatgpt.com directly, bypassing the proxy. **The invariant text needs updating to match reality** — it currently gives false assurance.

**Top structural problems** (each is a landing zone for a coming plan):
1. `api-routes.ts` — **1,205 LOC, 72 routes, inline handlers.** This file *is* the C1–C4 vulnerability: no dispatcher, no gate column, easy to add a route and forget the check. Split **before** Plan 5 adds invite/roster endpoints to it.
2. `credential-proxy.ts` (871 LOC) mixes proxying, route table, OAuth lifecycle, and a hard GWS import. It is Plan 4's landing zone — split first.
3. **Identity lives in three stores**: `playground-seats.json` (with a shared password), the `users` table, and `classroom_roster`. Unify on `users` **before** Plan 3, or the invite flow inherits the split.
4. `container-runner.ts` (714 LOC) has three competing restart paths.
5. `server.ts` (668 LOC) — extract the three auth flows before Plan 3 rewrites auth.

**Testing gaps that matter:** no seq-parity / `writeOutboundDirect` test; no cross-runtime `better-sqlite3` ↔ `bun:sqlite` contract test; a **proven false-green pattern** (mock-fetch + `process.env` tests shipped two web-search deploy bugs); `api-routes` dispatch and `server.ts` auth are untested — the exact code Plan 3 will refactor blind. **There is no test anywhere asserting that user A cannot touch user B's group.** That test, written first, would have caught C1–C4.

**Deletable now, ~1,730 LOC, zero behavior change:** `remote-control.ts`+test (597), `class-tunnel.ts`+test (287), `skeleton-mount-registry`+test (153), four orphaned scripts (638), a dead package script, the deprecated `openSessionDb`. Separately, as *product decisions* rather than cleanup: the knowledge/RAG explorer (~4,300 LOC) and the GWS suite (~4,900 LOC) appear in neither the department spec nor the roadmap — and GWS carries C7.

**Fork drift:** merge-based upstream sync is already dead (upstream deleted `credential-proxy.ts`; migration numbers collide at 019). Cherry-pick upstream's `recoverStaleOutboundJournals`-class fixes; keep the rest local. The pi swap itself is **cleanly contained** behind the provider seam — router, delivery, and sweep are untouched by it.

**What's genuinely good** (don't break these): the `state.md` decision-log discipline, which is what makes eventual upstream convergence plausible at all; the read-only DB opener enforcement and the documented parity rationale; real-infrastructure tests at the two riskiest seams (`host-core`, `credential-proxy`); the channel registry pattern; and the live-verification culture (Plan 1's chat turn was *actually driven*, which is how the container-provider bug got caught).

---

## Recommended sequence

**A new Plan 1.5 — "isolation hardening" — belongs before Plan 2, and absolutely before Plan 3 invites anyone.**

1. **One authorization helper on every mutation route** (fixes C1–C4). Add the missing-gate regression test *first*: "user A cannot read or write user B's group" across the whole route table.
2. **Bind identity server-side, not by header** (fixes C5, C7): mint a per-container secret at spawn, require it on `:3001` and `:3007`, derive the group from the secret; demote the header to logging. Bind both listeners to the bridge gateway rather than `0.0.0.0`, and turn the host firewall on.
3. **Scope `ncl` reads by caller group** (fixes C6) — the host already knows the true caller; wire `cli_scope` or delete the column.
4. **Enforce the budgets that already exist** and gate `direct-chat` on model allowlist + spend (H1, H2). `chmod 600 .env` (H6).
5. Then Plan 2's ports, with H3/H4/H5 folded in (they touch the same pi/poll-loop/session-manager files).
6. Fold the architectural pre-refactors (identity unification before Plan 3; `api-routes`/`credential-proxy` splits before Plans 4–5) into their respective plans, as scoped above.

Items C1–C4 and C6 are each a small, local change. The reason to do them as one deliberate pass, with a test that encodes the rule, is that this review found the same class of mistake in three independently-written subsystems — which means the codebase has no structural defense against making it a fourth time.

---

## Worth checking (not verified — do not treat as findings)

- `pnpm audit --prod` was not run to completion; `container/agent-runner`'s Bun dependencies have **no release-age policy** and were not pin-audited.
- Exhaustive sweep of all 89 `innerHTML` sites (a sample was clean: LLM output goes through `textContent`, metadata through `escapeHtml`).
- Per-adapter webhook signature verification (`webhook-server.ts:88` binds `0.0.0.0` and delegates verification to each Chat SDK adapter; no adapter ships in trunk).
- `sanitizeUserIdForPath` (`student-creds-paths.ts:19-42`) is lossy — crafted colliding user ids might alias two users' credential directories.
- Telegram pairing codes use `Math.random` (`channels` branch, not trunk).
- Whether the pi `cacheRetention='short'` (5-min TTL) default misses cache at real class cadence — measure once there is traffic.
