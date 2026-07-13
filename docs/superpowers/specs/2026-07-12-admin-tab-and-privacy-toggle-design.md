# Owner Admin Tab + Member Cloud↔Private Toggle — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-07-12.

## Where this sits (program context)

Part of the department-agent-server buildout. Today the owner manages users, login tokens, and per-agent model routing only through the `ncl` CLI, and members are pinned to whatever provider the owner set. This adds (1) an **owner-only Admin tab** in the playground that wraps the existing provisioning / token / usage machinery into a UI, and (2) a member-facing **Cloud ↔ Private privacy toggle** so each faculty member can move their own agent between a cloud provider and the on-box local model. Both surfaces read one shared, owner-set **department model config**.

## Goal

- Owner: add users + hand out magic links, see all active users at a glance (mode, model, activity, month-to-date cost), manage user lifecycle (rotate link, deactivate), set department model defaults, and see backstop-key health — without touching the CLI.
- Member: one-click switch their agent between **Cloud** (their assigned cloud provider) and **Private** (on-box local model — nothing leaves the box).

## Build order

Two phases, one spec. Phase 1 (Admin tab) is independently useful and establishes the shared dept config that Phase 2 consumes.

## Shared foundation — department model config

A minimal key/value config store in the central DB (`data/v2.db`), added by one migration:

```
app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)
```

Seeded keys (values from the A1 benchmark outcome):
- `default_cloud_model` = `qwen3.6-35b-a3b-fp8`, `default_cloud_provider` = `clemson`
- `private_model` = `Qwen3.6-35B-A3B-UD-MLX-4bit`, `private_provider` = `local`

Accessors: `getAppConfig(key)` / `setAppConfig(key, value)` in a new `src/db/app-config.ts`. **`provisionUser` reads `default_cloud_*` instead of the current hardcoded `qwen3.6-35b-a3b-fp8`/`clemson`** (`provision-user.ts:121-124`), so changing the dept default changes what new users get. The member toggle reads `private_*`. A tiny KV table (not overloading `container_configs` or the `_default_participant` template) keeps a global, non-per-group value where it belongs.

## Phase 1 — Owner Admin tab

### UI

A new `admin` tab, owner-only. Gated in `tab-gating.js`: add `'admin'` to an owner-only tab set (present in `tabsForRole`/`navTabsForRole` only when `hasFullAccess(role)`; never in `MEMBER_*`). `app.js` mounts `mountAdmin(el)` from a new `tabs/admin.js`. Four panels:

1. **Add user** — inputs: display name, `@clemson.edu` email. Submit → `POST /api/admin/users` → renders the returned login URL with **Copy** and **Rotate** buttons. Manual distribution (no email).
2. **Active users** — a table of all provisioned users. Columns: name, email, **mode** (cloud provider label, plus a "Private" badge when private mode is on), model, last-active, session status (running/idle), **month-to-date cost**. Row actions: **Rotate link**, **Deactivate** (confirm dialog → revokes access + all login tokens). Read-only otherwise — no per-user model override (model choice is the member's).
3. **Model defaults** — two selectors: default **cloud** model+provider and the **private** (on-box) model+provider, populated from the model catalog. Save → `PUT /api/admin/model-defaults` → writes `app_config`.
4. **Backstop key health** — dept OpenAI backstop key present/valid (from the credential-proxy env the host already reads) + total month-to-date spend against it (from the usage aggregation).

### Endpoints (all under `/api/admin/*`, each guarded by `if (!session.userId || !isOwner(session.userId)) return 403`)

| Method + path | Wraps | Returns |
|---|---|---|
| `POST /api/admin/users` | `provisionUser({displayName,email})` | `{ userId, folder, loginUrl }` |
| `GET /api/admin/users` | list provisioned users joined with per-user usage (the existing `/api/usage` aggregation) + session/model/mode | `{ users: [{name,email,folder,provider,model,privateMode,lastActive,session,costMtd}] }` |
| `POST /api/admin/users/:folder/rotate-link` | `rotateClassLoginToken(userId)` | `{ loginUrl }` |
| `POST /api/admin/users/:folder/deactivate` | revoke all tokens (`revoked_at` on `class_login_tokens`) + remove access (`user_roles`/`agent_group_members` for that user) | `{ ok }` |
| `GET /api/admin/model-defaults` | `getAppConfig` × 4 | `{ defaultCloud:{model,provider}, private:{model,provider} }` |
| `PUT /api/admin/model-defaults` | `setAppConfig` × 4 | `{ ok }` |
| `GET /api/admin/backstop-health` | proxy env check + usage total | `{ keyPresent, keyValid, spendMtd }` |

Handlers live in a new `src/channels/playground/api/admin.ts`; route wiring in `api-routes.ts` alongside the existing `/api/admin/students/` block.

## Phase 2 — Member Cloud ↔ Private toggle

### UI

The toggle **replaces** the read-only "Running on: …" chip in the MyAgent view (`member-chat.js:136-137`, `modelLabel`). It renders the current mode and switches it:
- **Cloud** — the member's assigned cloud provider (Clemson default *or* their connected ChatGPT). Label shows which (e.g. "Cloud — Clemson (free)" / "Cloud — your ChatGPT").
- **Private** — the dept on-box local model. Label: "Private — on-box, stays local".

Toggling calls `POST /api/me/privacy-mode { private: true|false }`, then updates the chip and shows a brief "switching…" state (the container recycles).

### Mechanism

Member-self endpoint (`/api/me/*` — acts only on the caller's own agent group; reuses the existing me-auth resolution, not `isOwner`):
- **Turn Private ON:** read the caller's group `container_configs` current `(model_provider, model)`; if it is not already the private pair, stash it in `agent_groups.metadata` under `cloudChoice = {provider, model}`; then `updateContainerConfigScalars(agentGroupId, { model_provider: private_provider, model: private_model })` (from `app_config`); recycle the container (stop via the runtime CLI so the next turn re-materializes — the A1-proven pattern).
- **Turn Private OFF:** restore `(provider, model)` from `agent_groups.metadata.cloudChoice`; if absent, fall back to the dept `default_cloud_*`; write via `updateContainerConfigScalars`; recycle.

`container_configs.model_provider/model` always holds the **effective** (currently-active) routing values, so the credential-proxy routing path is unchanged. `privateMode` shown in the admin list is derived: `model_provider === private_provider`.

## Out of scope (v1)

- Email delivery of magic links (manual distribution; email transport deferred).
- Per-user model override from the admin tab (members own their model choice).
- Automatic runtime failover between models.
- Unknown-sender / dropped-message review in the admin tab.
- Any change to the member's ChatGPT-connect flow (A2) — Private layers on top of whatever cloud provider they're set to.

## Security

- Every `/api/admin/*` endpoint owner-gated (`isOwner`), mirroring `/api/admin/students/:folder`.
- The privacy toggle is member-self-only: it resolves the caller's own agent group and never accepts a target folder/user from the request body — a member can only switch their own agent.
- Provisioning stays transactional; the login token is minted last (as `provisionUser` already does), so a failed scaffold never leaves a live token.
- Login URLs are bearer credentials: shown in-UI for copy, never logged.

## Error handling

- Add-user: duplicate email / invalid domain → 400 with a clear message; `provisionUser` is idempotent-safe (does not double-mint for an existing identity).
- Toggle: if `app_config` private/default values are missing, return 409 with "department model config not set" rather than writing a bad model id; if the container recycle fails, the DB write still stands and the next turn picks it up.
- Deactivate: confirm dialog client-side; server revokes tokens + access idempotently.

## Testing

- Owner gate: non-owner session → 403 on every `/api/admin/*` endpoint (one parameterized test).
- Add-user: returns a URL that redeems to a working session (mirror the A1 redeem check).
- Model-defaults round-trip: `PUT` then `GET` returns the written values; `provisionUser` reads them.
- Privacy toggle: ON stashes cloud choice + sets private pair; OFF restores it; OFF with no stash falls back to dept default; effective `model_provider` reflects the active mode.
- Toggle authz: the endpoint ignores any body-supplied folder and only mutates the caller's group.
- Admin user-list shape: fields present, cost sourced from usage, `privateMode` derived correctly.

## Open items to confirm during planning

- Exact existing "deactivate/remove access" primitive (which of `user_roles` / `agent_group_members` / a `users` status field the codebase already uses for removing a user's access) — reuse it rather than inventing one.
- The model catalog source the two dept-default selectors read (reuse the `/api/models` or `/api/catalog` catalog the models tab already uses).
- Whether "last-active" comes from session heartbeat or the last outbound message timestamp.
