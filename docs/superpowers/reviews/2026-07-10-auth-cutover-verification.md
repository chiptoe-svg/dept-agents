# Auth Cutover Verification — `PLAYGROUND_AUTH_BYPASS` retired

**Date:** 2026-07-10. Plan 3, Task 5. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, `http://gcworkflow.clemson.edu:8088`).

## Result: PASS — bypass retired, per-user isolation enforced live

`PLAYGROUND_AUTH_BYPASS=0` in `.env`; service rebuilt and restarted; `authMode` is now magic-link. Every web session is a real authenticated user, not the owner.

## What changed to make the cutover possible (found live, fixed en route)

- **`PUBLIC_PLAYGROUND_URL` was `:3002`** (the localhost-only internal bind) → every invite URL would have been dead. Corrected to `http://gcworkflow.clemson.edu:8088` (the Caddy proxy).
- **PIN 2FA was hardcoded ON** (`class-login-tokens.ts` called `setPinRequiredForClassToken(true)` unconditionally). With no email transport the PIN can never be delivered, so nobody could log in. Made configurable via `PLAYGROUND_LOGIN_PIN_REQUIRED` (default **false**); commit `42c952a6`. The bookmarkable token URL is the credential for the pilot (see Security note in the plan).
- **`playground:owner_01` had no membership row** → with the Task-1 resolver fix, the operator would have logged in to *no* agent. Membership added.

## The four cutover checks (live, bypass off)

Requests made with `curl` against the running service. Login tokens redeemed into session cookie jars; token values never printed.

| # | Check | Request | Result | Pre-cutover behavior |
|---|---|---|---|---|
| 1 | **Operator logs in** | redeem operator token URL → `GET /api/me/agent` with session cookie | `{"user":{"id":"playground:owner_01","role":"owner"},"agent":{"id":"ag_1783646694218_qht2p4","folder":"owner_01"}}` — resolves to the operator's own group | (bypass masked all sessions as owner) |
| 2 | **Colleague logs into their OWN agent** | provision `Canary Colleague`; redeem their URL → `GET /api/me/agent` | `{"user":{"id":"playground:canary_colleague","role":"member"},"agent":{"id":"ag-1783713356900-4hnuck","folder":"canary_colleague"}}` — a **distinct** user (role member, not owner) in a **distinct** agent | would have resolved to the first group / owner |
| 3 | **Anonymous is refused** | `GET /api/me/agent` with no cookie | **401** | returned the owner (200) |
| 4 | **Cross-tenant is refused** | canary session → `PUT /api/drafts/owner_01/persona`; also `POST .../messages`, `POST /api/simple-restart` | **403** on all three; `PUT /api/drafts/canary_colleague/persona` (own) → **200** | all succeeded (owner authority) |

## End-to-end chat (the routing proof)

The canary is not just able to log in — their agent works. Posting a message as the canary through the real HTTP path (`POST /api/drafts/canary_colleague/messages`, session cookie) returned 200, spawned a container for the canary's group, and the agent replied **`onboarded`** in ~20s. This confirms the Task-2 `unknown_sender_policy: 'public'` routing fix: a provisioned colleague's messages actually reach their agent.

## Isolation properties confirmed at provision time

For `ag-1783713356900-4hnuck` (the canary): `container_configs.provider = 'pi'` with the curated MCP set seeded; `unknown_sender_policy = 'public'` (matches the working owner group); `user_roles` count = **0** (unprivileged member, no admin grant); email `canary@clemson.edu` stored in `agent_groups.metadata`.

## Standing state after the cutover

- `PLAYGROUND_AUTH_BYPASS=0` — do not re-enable without cause.
- The operator logs in via their bookmarkable token URL (held privately, not in this doc). Re-mint/rotate with the durable-token path if lost.
- Residual limits (tracked, non-blocking for a 2–3 person pilot): plain-HTTP transport means the URL/cookie are observable to a network MITM; a login URL is a bearer credential reusable until revoked (PIN 2FA closes this once email exists). See the plan's Security note.
- The `Canary Colleague` test identity was created for this verification and removed afterward (token revoked, entities deleted).
