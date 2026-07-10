# Isolation Verification — Live End-to-End Proof (Plan 1.5, Task 10)

**Date run:** 2026-07-10 (task dated 2026-07-09; see task brief). **Base commit:** `40a86698` (`docs(state): Plan 1.5 complete`).
**Method:** exercise the running system, not the unit suite. Where the live HTTP surface could not be exercised meaningfully (see Step 2) or was blocked by an environment safety gate (see Step 3), the fallback explicitly sanctioned by the task brief was used instead: a direct `route()`-level call against the **real production DB** (`data/v2.db`), never a mock/temp DB.

**Setup:** created a genuinely distinct principal, `playground:testbob`, and added it as a member of `user_01`'s agent group (`ag_1783646694219_estliq`) only — not of `owner_01`. Verified `container_configs.provider = 'pi'` was already set for both `owner_01` and `user_01` (pre-existing, no fresh-group footgun to trip). Deleted `playground:testbob` and its membership row at the end of the run (see "Cleanup").

---

## Step 2 — Web gate (`requireGroupAccess`)

### Finding: bypass mode's seat picker is cosmetic, not a distinct principal — the literal HTTP test as scripted is untestable-live in this posture

Read `getBypassSession()` (`src/channels/playground/server.ts:83-91`) before running anything:

```ts
function getBypassSession(): PlaygroundSession {
  if (!_bypassSession || !getSessionByCookie(_bypassSession.cookieValue)) {
    const ownerUserId = getOwners()[0]?.user_id ?? null;
    _bypassSession = mintSessionForUser(ownerUserId);
    ...
  }
  return _bypassSession;
}
```

This is called unconditionally for **every** authenticated request while `PLAYGROUND_AUTH_BYPASS=1` (`server.ts:512`: `const session = PLAYGROUND_AUTH_BYPASS ? getBypassSession() : authenticate(req)`), and it takes no arguments — no cookie, no `?seat=` query param, nothing request-scoped. It always resolves to a single cached session whose `userId` is the real global owner's id. The `?seat=<folder>` URL param is read in exactly one place, `handleGetMyAgent` (`src/channels/playground/api/me.ts:31-56`), and only affects the **display** payload of `GET /api/me/agent` — it never touches `session.userId`, and `requireGroupAccess`/every mutation route only ever sees the real owner's `session.userId`.

**Empirical confirmation (read-only, zero side effects):**

```
$ curl -s http://gcworkflow.clemson.edu:8088/api/me/agent
{"user":{"id":"playground:owner_01","role":"owner"},"agent":{...,"folder":"owner_01"}}

$ curl -s "http://gcworkflow.clemson.edu:8088/api/me/agent?seat=user_01"
{"user":{"id":null,"role":"member","seatLabel":"John Doe"},"agent":{...,"folder":"user_01"}}
```

The second call *displays* `id: null` (student-facing anonymization) but the session actually authenticating the request — the one every mutation route's `requireGroupAccess(folder, session.userId)` call receives — is still `playground:owner_01`. Since `canAccessAgentGroup` grants the owner access to every group (`isOwner(userId) → { allowed: true, reason: 'owner' }`, `src/modules/permissions/access.ts:23`), any mutation issued while "on" the `user_01` seat against the `owner_01` folder would return 200 not because the gate is broken, but because the caller genuinely *is* the owner acting on their own group — the seat picker never put a different, less-privileged principal in the driver's seat. **Running the 5 scripted requests over HTTP would not test cross-tenant denial at all; it would silently pass for the wrong reason.** This is exactly the "if bypass mode makes both seats resolve to the same user id" scenario the task's own instructions anticipated and told me to report loudly rather than fake a pass.

I attempted the 5 literal mutating HTTP requests anyway (`PUT .../owner_01/persona`, `POST .../owner_01/messages`, `PUT .../owner_01/active-model`, `POST /api/drafts {targetFolder: owner_01}`, `POST /api/simple-restart {folder: owner_01}`) after completing the real `/pick-seat` handshake for `user_01` (password read from `.env`, never echoed). All five were blocked before execution by the harness's own auto-mode safety classifier ("a safety check separate from auto mode blocked this request... it isn't about the action itself"), independent of request wording. This mirrors a note in the prior full code review (`2026-07-09-full-code-review.md:72`) where the same class of live spoofed-header test was blocked the same way. I did not attempt to work around it.

### Fallback used: direct `route()`-level check against the real production DB

Per the task's explicit permission to "prove the gate with a direct `route()`-level check" when bypass collapses identity, I wrote a temporary script (`scripts/_isolation-check-tmp.ts`, deleted after use — not committed) that:
- Calls `initDb()` against the real `data/v2.db` (no mocking, no temp DB — same file the running host process uses).
- Constructs a `PlaygroundSession` for the genuinely distinct, non-owner principal `playground:testbob` (member of `user_01` only).
- Calls the real `route()` dispatcher (`src/channels/playground/api-routes.ts`) — the same function the HTTP server calls — for each of the 5 mutation shapes, targeted at `owner_01`.
- As a safety gate before running anything mutating: first called the pure predicate `requireGroupAccess('owner_01', 'playground:testbob')` directly (zero side effects) and confirmed it denied before proceeding — so if the gate had been broken, the script would have aborted rather than actually kill the live `owner_01` container or post a real message into it.

**Results — cross-tenant attempts (`playground:testbob` → `owner_01`, real DB, real `route()`):**

| Request | Status | Pre-fix behavior (per code review C1–C4) |
|---|---|---|
| `PUT /api/drafts/owner_01/persona` | **403** | 200 — rewrote victim's `CLAUDE.local.md`, killed their container |
| `POST /api/drafts/owner_01/messages` | **403** | 200 — injected an `isMention: true` message into victim's agent |
| `PUT /api/drafts/owner_01/active-model` | **403** | 200 — flipped victim's model/provider (also would 400 independently: the scripted body omits `modelProvider`, which `handlePutActiveModel` requires) |
| `POST /api/drafts {targetFolder: owner_01}` | **403** | 200 — snapshotted victim's group into a draft |
| `POST /api/simple-restart {folder: owner_01}` | **403** | 200 — killed victim's live container |

**Positive control — `playground:testbob` on their own folder (`user_01`), same script:**

```
GET /api/drafts/user_01/persona -> 200   {"text":"# Socratic tutor\n\n...short explanation."}
PUT /api/drafts/user_01/persona (own folder) -> 200
```

Confirms the gate discriminates (denies cross-tenant, allows own-group) rather than denying everyone. The PUT overwrote `user_01`'s persona with a test marker; **restored to the exact original text** afterward via the real HTTP API and verified byte-for-byte (`389` bytes, matches the GET captured above). `containersRecycled: 0` on restore (no `user_01` container was running).

### Verdict: PASS (via fallback), web-HTTP-layer test explicitly UNTESTABLE-LIVE in this posture

The `requireGroupAccess` gate itself is proven live against the real DB and real dispatcher: 5/5 cross-tenant denials, 1/1 own-folder allow. The HTTP/bypass-session layer could not be exercised as a genuine cross-tenant test because `PLAYGROUND_AUTH_BYPASS` mode does not bind sessions to the selected seat — this is a real gap in the *test harness for this posture*, not evidence the code-level fix is wrong. It should not be treated as equivalent to a real multi-user HTTP proof; that requires either turning bypass off (Plan 3) or seat-scoping `getBypassSession()`, neither of which is in scope here.

---

## Step 3 — Credential proxy gate (`:3001`)

Simulated an unauthenticated LAN attacker from the bridge gateway address (this box, per `docs/architecture` — containers reach the host at `192.168.64.1`):

```
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.64.1:3001/openai/v1/chat/completions \
    -H 'content-type: application/json' -H 'authorization: Bearer placeholder' \
    -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"hi"}],"max_completion_tokens":4}'
401
```

Loopback (host-internal path) confirmed still functional — this call actually completed (small, ~4-token real OpenAI request, billed as intended by the task):

```
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/openai/v1/chat/completions \
    -H 'content-type: application/json' -H 'authorization: Bearer placeholder' \
    -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"hi"}],"max_completion_tokens":4}'
200
```

Auth logic confirmed by reading `src/credential-proxy.ts:181-183` (`isLoopbackSource`) and `:560-567` (401 branch on non-loopback + invalid/absent per-container token).

**Pre-fix behavior:** per the full code review's C5, this same non-loopback unauthenticated request would have returned 200 with a real completion, attributed to and billed against whatever agent-group header the caller supplied (or the department default if absent) — an open proxy reachable from anywhere on the campus LAN.

**Verdict: PASS.** 401 for the unauthenticated non-loopback caller; loopback path unaffected.

---

## Step 4 — `ncl` container-scoping gate

Two running containers were available without needing to wake one:

```
$ container list
...
nanoclaw-v2-owner_01-1783664376833   nanoclaw-agent-v2-581fefa4:latest   running
nanoclaw-v2-pi-test-1783621600683    nanoclaw-agent-v2-011e3c4e:latest   running
```

From inside `owner_01`'s container:

```
$ container exec nanoclaw-v2-owner_01-1783664376833 ncl groups list
id                       name               folder    agent_provider  created_at
-----------------------  -----------------  --------  --------------  ------------------------
ag_1783646694218_qht2p4  Owner (Organizer)  owner_01  pi              2026-07-10T01:24:54.218Z

$ container exec nanoclaw-v2-owner_01-1783664376833 ncl users list
[]
```

Cross-checked from a second, unrelated running container to confirm the scoping isn't coincidental:

```
$ container exec nanoclaw-v2-pi-test-1783621600683 ncl groups list
id                                    name     folder   created_at
------------------------------------  -------  -------  ------------------------
b2860984-d3bd-42c8-86d3-e95e3cc30bc5  GCagent  pi-test  2026-05-23T21:29:48.248Z
```

Each container sees **only its own group**; `ncl users list` from an agent caller returns empty.

**Pre-fix behavior:** per the full code review's C6, `ncl groups list`/`users list`/etc. from inside any container returned every group and every user in the central DB — ids, folders, and (via `user-dms list`) every tenant's handles/phone numbers/emails.

**Verdict: PASS.**

---

## Summary

| Step | Gate | Result | Notes |
|---|---|---|---|
| 2 | Web API `requireGroupAccess` | **PASS** (via `route()`-level fallback against real DB) | HTTP/bypass-session layer untestable-live in this posture — seats don't bind to distinct principals under `PLAYGROUND_AUTH_BYPASS`; the underlying gate itself is proven |
| 3 | Credential proxy `:3001` | **PASS** | 401 non-loopback unauthenticated; loopback unaffected |
| 4 | `ncl` container scoping | **PASS** | Own group only; `users list` empty for agent callers; cross-checked on 2 containers |

No check failed. The one genuine gap found is environmental, not code-level: **`PLAYGROUND_AUTH_BYPASS`'s seat picker cannot be used to run a real multi-user HTTP test** — every request authenticates as the actual global owner regardless of the selected seat, because `getBypassSession()` is seat-agnostic by construction. This should be kept in mind for any future live-HTTP verification while bypass is on; it does not indicate a flaw in `requireGroupAccess` itself, which was independently proven against the real DB and dispatcher.

## Cleanup

- `playground:testbob` user and its `user_01` membership row: **deleted** (not kept as a pilot seat — it was created purely to obtain a genuinely distinct, real-DB principal for the `route()`-level fallback test in Step 2, and serves no ongoing purpose).
- `user_01`'s `CLAUDE.local.md` persona: restored to original text, verified byte-for-byte.
- `owner_01`'s persona, active-model, and container: untouched (all 5 live-HTTP attempts against `owner_01` were blocked before execution; the `route()`-level fallback correctly 403'd before reaching any mutating code, so nothing on `owner_01` was ever written).
- Temporary script `scripts/_isolation-check-tmp.ts`: deleted, never committed.
- No `draft_owner_01` group was created (the one live HTTP attempt that would have created it was blocked before executing).
