# Provider Auth & Backstop — live verification

**Date:** 2026-07-10. Plan 4, Task 5. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, `http://gcworkflow.clemson.edu:8088`).

## Result: PASS

Deploy clean: schema at v25 (the `backstop_usage` migration applied), `backstop_usage` table present, boot with no errors.

## 1. The department-key backstop works and is recorded (unconnected user)

The owner (`playground:owner_01`) has no connected per-user credentials (`ls data/user-provider-creds/` → only an unrelated `telegram_8731035088`). A real agent turn was driven for the owner's group (`ag_1783646694218_qht2p4`) via the session inbound DB.

- **Reply:** `dept` — the turn succeeded on the department `.env` key (the backstop). The backstop does not break normal turns.
- **Recorded:** `backstop_usage` now holds `ag_1783646694218_qht2p4 | claude | 2026-07-10T23:37:56Z`. `resolveUserCreds` returned `null` (no per-user creds), the proxy attached the `.env` credential, and the debounced recorder logged the fallback — exactly as designed. The operator can now query which groups are running on the department account.

## 2. A connected user resolves to their OWN credentials (not the backstop)

The one connected identity on the box, `telegram:8731035088`, is **not** a member of any agent group here (a leftover credential), so a full live turn for a connected user could not be driven. Verified at the storage + resolution level instead, which the unit-tested resolver logic then acts on:

- **The real stored credential loads under the correct key.** `loadUserProviderCreds('telegram:8731035088', 'codex')` returns `active=apiKey, hasOAuth=true, hasApiKey=true` (token values not inspected). The OAuth token is long-expired, but `active=apiKey`, so the resolver returns the API key.
- **The proxy and the store agree on the provider key.** `credential-proxy.ts:682` passes `providerId = 'codex'` for the OpenAI route (the *auth* provider id, distinct from the catalog display name `openai-codex`), which is exactly the key the credential is stored under. So `resolveUserCreds` finds and returns this user's own creds — it does **not** fall through to the backstop for a connected user. (Earlier confusion: `loadUserProviderCreds(user, 'openai-codex')` returns null because that's the catalog name, not the auth id; the proxy never uses it.)
- The resolver's own-creds-returned / not-null / recorder-not-fired behavior is unit- and mutation-tested (Task 1).

## 3. The "Connect ChatGPT" endpoints are mounted and require authentication

- `GET /api/provider-auth/codex/status` unauthenticated → **401** (the newly-mounted status route; a fuller authenticated 200 with `{hasApiKey, hasOAuth, active}` is unit-proven in Task 3).
- `GET /provider-auth/codex/start` unauthenticated → **401** (the pre-existing start route in `server.ts`).

A user cannot start or inspect an OAuth flow without an authenticated session; the user id comes only from `session.userId`.

## Standing state

- Every agent turn now resolves credentials via the entity model (`agent_group_members` → user): the user's own creds if connected, else the department `.env` key with the fallback recorded.
- Connect is optional — no `forbidden`/`connect_required` hard block. `class-controls` is gone.
- **Deferred to Plan 5** (tracked in the ledger): the homepage "connect your ChatGPT / running on the department account" banner (this plan emits the event; Plan 5 renders it); the `classroom_roster` table drop and `class-*` renames; a stale-`auth.json` cleanup path; the models-tab availability keying off owner creds rather than the `.env` backstop.
