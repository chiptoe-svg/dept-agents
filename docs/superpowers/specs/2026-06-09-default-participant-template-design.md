# Default Participant Template — Design Spec

**Date:** 2026-06-09
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Give the install owner a way to define **exactly what a new Participant starts with** — persona, CLAUDE.md, skills, model/provider — by configuring one dedicated **template agent** through the existing playground agent-editing UI, then **"Save as default."** New Participants provision from that saved default. A second, explicit owner action **"Apply default to all Participants"** resets every existing Participant to the default (reversibly). The default must be **independent of the owner's own agent** (today new users inherit skills from the owner agent via `inheritedSkills()` — that coupling is removed).

This is **platform** infrastructure (provisioning + a default benefits every scenario/install), so it lives in trunk (`src/`), not a scenario profile.

## Decisions (settled during brainstorming)

1. **Approach A** — a dedicated template agent edited via the existing per-agent UI, snapshotted into a stable default slot; provisioning reads the slot. (Rejected: an abstract config form — duplicates existing UI; copying the live template on-demand — half-finished edits would leak.)
2. **Dedicated template agent**, not a real Participant and not the owner agent. Folder `_default_participant`, flagged so it is never paired, never a roster member, excluded from "apply to all", and `roleForFolder` returns `null` for it.
3. **Participants only** (canonical role `user`). Organizer/IT Admin/Facilitator are configured by hand and untouched. Per-role templates are deferred (YAGNI).
4. **"Apply to all" = full replace + auto-backup + restart**, reversible: each affected Participant's current agent is snapshotted into their own agent-library as a restore point before being overwritten; then their container is restarted. Requires a typed confirmation; shows the affected count first.
5. **Scenario-aware provisioning is in scope.** Provisioning currently hardcodes `student_NN` folders + `class-config.json`; the seminar uses `user_NN`. Provisioning becomes generic: it allocates the folder from the active scenario's per-role prefix and reads the default slot for content. Scenario-specific post-provision steps (classroom's `class-config.json` roster append) move to an optional scenario hook.

## Background (current state)

- **Provisioning** (`src/class-student-provision.ts`, `provisionStudent`): allocates `student_NN` via `nextStudentFolder()` (regex `^student_`), creates `agent_groups` + `users` + roster + membership rows, writes persona to `CLAUDE.local.md` (from `roleProfile('user')` with `STUDENT_PERSONA` fallback), `CLAUDE.md` from a constant, skills via `inheritedSkills()` (copies the first `dm-with-*` group — the owner-coupling to remove), provider/model from `NANOCLAW_STUDENT_*` env. Only caller: `src/channels/playground/api/students-admin.ts` (`POST /api/admin/students`).
- **Agent-library** (`src/channels/playground/api/agent-library.ts`): per-user named snapshots under `groups/<folder>/library/<slug>/`. `saveEntry(folder, slug, includeMemory)` copies `CLAUDE.md`, `container.json`, `custom-skills/`, and (when `includeMemory`) `CLAUDE.local.md`. `loadEntry(folder, slug)` restores. There is already a `DEFAULT_AGENTS_DIR` of owner templates + `listDefaultAgents()`, but it is **not** wired into provisioning.
- **Scenario contract** (`src/scenarios/types.ts`, `registry.ts`): `roleForFolder(folder)→CanonicalRole|null`, `roleProfile(role)→{label,permission,persona,greeting}`, `memberName(folder)`. Roles: `owner | it_admin | assistant | user`.
- **Drafts/workbench** (`src/agent-builder/core.ts`): editing an agent = `createDraft(target)` (folder `draft_<target>`) → edit → `applyDraft`. Drafts require a real target group. This is the existing "edit an agent" surface ("the Jane Doe path").
- **Owner gating** pattern: `isOwner`/`isGlobalAdmin` from `modules/permissions/db/user-roles.ts`, wrapped as `isOwnerOrAdmin` (see `api/enrollment.ts`).
- **Owner-config-as-JSON** precedent: `api/class-controls.ts` reads/writes `data/config/class-controls.json`.

## Architecture

### Component 1 — Scenario contract: per-role folder prefix + provision hook

Add to the `Scenario` interface (`src/scenarios/types.ts`):

```ts
/** Folder prefix used to provision a member of each canonical role this scenario uses. */
folderPrefix: Partial<Record<CanonicalRole, string>>;
/** Optional scenario-specific work after a member is provisioned (e.g. classroom roster append). */
onMemberProvisioned?: (folder: string, member: { name: string; email: string; role: CanonicalRole }) => void;
```

- **classroom** (`src/scenarios/classroom/scenario.ts`): `folderPrefix = { owner: 'instructor_', assistant: 'ta_', user: 'student_' }`; `onMemberProvisioned` appends the member to `class-config.json` (preserves classroom's config-based `roleForFolder`). Moves the existing `appendStudentToClassConfig` logic here.
- **industryai_seminar** (`src/scenarios/industryai_seminar/scenario.ts`): `folderPrefix = { owner: 'owner_', it_admin: 'it_admin_', assistant: 'assistant_', user: 'user_' }`; no `onMemberProvisioned` (prefix-based `roleForFolder` needs no roster).

Add registry accessors (`src/scenarios/registry.ts`): `folderPrefix(role)` and `onMemberProvisioned(folder, member)` delegating to the active scenario (null/no-op when unset).

### Component 2 — Generic provisioning (`provisionMember`)

Refactor `provisionStudent` → a generic `provisionMember({ role = 'user', name, email, addedBy })` in `src/class-student-provision.ts` (or a renamed module; keep `provisionStudent` as a thin `role:'user'` wrapper so `students-admin.ts` keeps working without signature churn):

1. **Folder allocation** — `nextFolderForRole(role)`: read the active scenario's `folderPrefix[role]`; scan `agent_groups.folder` for `^<prefix>(\d+)$`; return `<prefix><max+1>`. Replaces `nextStudentFolder()` (which becomes `nextFolderForRole('user')`). If the scenario has no prefix for the role, error clearly.
2. **DB rows** — unchanged (`agent_groups`, `users`, membership). The roster/`class-config.json` step is no longer inline; it is delegated to `onMemberProvisioned`.
3. **Content from the default slot** (Component 3): if `data/config/default-participant/` exists, copy its `CLAUDE.local.md` (persona), `CLAUDE.md`, `custom-skills/` into the new group and set `container_configs` `provider`/`model`/`effort`/`skills` from its `container.json`. **Remove `inheritedSkills()` (owner coupling).**
4. **Fallback** (no default saved yet): persona from `roleProfile(role)` (existing behavior), `CLAUDE.md` from the existing constant, skills = a fixed built-in default (e.g. `'all'`), provider/model from `NANOCLAW_STUDENT_*` env (kept only as the no-default fallback). Nothing breaks on a fresh install before a default is saved.
5. **Scenario hook** — call `onMemberProvisioned(folder, { name, email, role })`.
6. Keep `.class-shared.md` symlink behavior (it is classroom-shared-stance; harmless elsewhere — leave as-is for now).

### Component 3 — The template agent + default slot

- **Template agent:** a real `agent_groups` row + on-disk folder `_default_participant`, name "Default Participant Template", created once by an idempotent bootstrap (a migration or lazy-create on first `GET /api/default-participant`). Seeded initially from the scenario `roleProfile('user')` persona + built-in defaults. Metadata flag `{ template: true }`.
  - **Exclusions (must all hold):** `roleForFolder('_default_participant')` is `null` (no scenario prefix matches `_default_participant`); excluded from any Participant/roster list in the UI (filter by the `template` metadata flag or the reserved folder); never wired to a messaging group (never paired); skipped by "apply to all". It is edited via the **existing** workbench (`createDraft('_default_participant')` → edit → `applyDraft`) exactly like any agent.
- **Default slot:** `data/config/default-participant/` containing `CLAUDE.local.md`, `CLAUDE.md`, `container.json`, `custom-skills/`, and `meta.json` (`{ savedAt, savedBy }`). Written by "Save as default" — a `saveEntry`-style copy of the template group's files into the slot (with persona, i.e. `includeMemory: true`). This snapshot, not the live template, is the provisioning source of truth (mid-edit states never leak).
- **Config storage note (important):** since Phase B½, container config is authoritative in the **`container_configs` DB table**, not the on-disk `container.json`. So "Save as default" serializes the template's `container_configs` row (provider/model/effort/skills/mcp/mounts/packages) into the slot's `container.json`; provisioning and apply-all **write `container_configs` rows** from that serialization rather than dropping a file and hoping it is read. Treat `container.json` in the slot as a portable serialization, the DB row as the runtime truth. (The existing `agent-library` `saveEntry` copies the file only — the save/apply paths here must additionally read/write `container_configs`. Confirm during planning whether to extend `saveEntry` or add a small DB-aware helper.)

### Component 4 — Owner playground card + API

New owner-gated handlers (`src/channels/playground/api/default-participant.ts`), gated with `isOwnerOrAdmin` (mirror `enrollment.ts`), wired in `src/channels/playground/api-routes.ts`:

- `GET /api/default-participant` → `{ saved: boolean, savedAt, savedBy, templateFolder: '_default_participant', participantCount }` (and ensures the template agent exists — lazy bootstrap).
- `POST /api/default-participant/save` → snapshot template group → default slot; write `meta.json`. Returns new `savedAt`.
- `POST /api/default-participant/apply-all` → Component 5. Body must include a confirmation token (e.g. `{ confirm: "APPLY" }`); returns `{ affected: number, restorePoints: string[] }`.

New owner-only **"Default Participant Template"** card on the Home tab (`src/channels/playground/public/...`): a deep-link to edit the template agent in the existing workbench, a **Save as default** button (shows `savedAt`), and an **Apply default to all Participants** button (shows the affected count, requires typed confirmation).

### Component 5 — Apply-to-all (reversible reset)

`POST /api/default-participant/apply-all`, owner-only, after typed confirmation. For each `agent_groups` row where `roleForFolder(folder) === 'user'` (this naturally excludes the template, Organizer, IT Admin, Facilitators):

1. **Backup:** `saveEntry(folder, 'pre-default-reset-<ISO-ts>', true)` → a restore point in *that Participant's own* agent-library.
2. **Overwrite:** copy the default slot's `CLAUDE.local.md`, `CLAUDE.md`, `custom-skills/` into the group root; set `container_configs` `provider`/`model`/`effort`/`skills` from the slot's `container.json`.
3. **Restart:** restart the group's container via the existing restart primitive (`ncl groups restart` equivalent / container-runner) so the next message uses the new agent.

Return the affected count + the list of restore-point slugs. Reversible: any Participant (or the owner) can `loadEntry` their `pre-default-reset-*` snapshot.

## Data flow

```
Owner edits _default_participant (existing workbench: createDraft → edit → applyDraft)
        │  POST /api/default-participant/save
        ▼
data/config/default-participant/  (CLAUDE.local.md, CLAUDE.md, container.json, custom-skills/, meta.json)
        │                                   │
  provisionMember('user', …)          POST …/apply-all  (per user-role group:
  reads slot → new user_NN group        backup→overwrite→restart)
```

## Boundaries (explicitly out of scope)

- Per-role templates (only the `user`/Participant default). One default slot.
- No change to pairing, the scenario contract's role *semantics*, `roleProfile` (kept as the fallback), or the `DEFAULT_AGENTS_DIR` user-facing "default agents" library.
- Does not migrate existing `student_NN` data to `user_NN`; only changes how *new* members are provisioned under the active scenario.
- `.class-shared.md` symlink behavior unchanged (a later vocabulary/scenario-cleanup concern).

## Testing / success criteria

Unit (vitest, in-memory DB):
- `nextFolderForRole('user')` returns the active scenario's prefix + next index (seminar → `user_NN`; classroom → `student_NN`).
- `provisionMember` reads the default slot when present (persona/CLAUDE.md/skills/provider/model match the slot) and falls back to `roleProfile` + built-in defaults when the slot is absent. No `inheritedSkills()`/owner-coupling.
- Save snapshots the template group → slot (incl. persona) + `meta.json`.
- Apply-all: backs up each `user`-role group, overwrites from the slot, requests restart; **skips** the template, owner, it_admin, assistant groups; requires the confirm token; returns the affected count + restore-point slugs.
- `onMemberProvisioned`: classroom appends to `class-config.json`; seminar is a no-op.
- Owner-gating: all three endpoints reject non-owner/admin sessions.

Build clean (`pnpm run build`) + full suite green (`pnpm test`).

Live check (seminar install): edit `_default_participant`, Save as default; provision a new Participant → comes out `user_NN` with the default content; Apply-to-all → existing `user_NN` Participants reset, each with a `pre-default-reset-*` restore point, containers restarted.

## Risks / notes

- **Provisioning refactor blast radius:** `provisionStudent` is classroom-shaped and the only caller is `students-admin.ts`. Keep a `provisionStudent` wrapper to avoid churn. Gate on the full suite.
- **Scenario contract growth:** `folderPrefix` + `onMemberProvisioned` extend the contract; both scenarios must implement `folderPrefix`. This is the same contract touched by the 2026-06-09 pairing work — keep additions minimal and tested.
- **Template agent must stay non-live:** verify it never spawns a real-message container, never appears in Participant lists, and is excluded from apply-all. A stray container or list leak is the main correctness risk.
- **Restart load:** apply-all restarts every Participant container; on a large cohort, restart sequentially/throttled to avoid a thundering herd.
- **Breakable pilot:** in-place is fine, but restart-verify after the provisioning change (the credential-dir migration earlier is the cautionary tale).

## Suggested phasing (for the implementation plan)

1. Scenario contract: `folderPrefix` + `onMemberProvisioned` + registry accessors + both scenarios + `nextFolderForRole`.
2. Generic `provisionMember` reading the default slot (+ fallback), `provisionStudent` wrapper, remove `inheritedSkills()` coupling.
3. Template agent bootstrap + default slot + `GET`/`save` endpoints + owner card (edit + save).
4. Apply-to-all endpoint (backup→overwrite→restart) + card action + confirmation.
5. Live verification on the seminar install.
