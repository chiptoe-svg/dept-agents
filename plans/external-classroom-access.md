# External classroom access — Add Student button + guest tunnel

## Goal
Give the instructor a one-click way, from the playground Home tab, to add a
student to the class and (for an off-campus feedback guest) hand them a single
working login URL — without re-running the bulk class-skeleton script.

## Decisions (2026-05-20)
- **Add Student button** — lives on the instructor's playground Home tab
  (owner-only "Add Student" card). Form: name + email + an "external guest"
  checkbox.
- **Integrated guest mode** — one form. Checking "external guest" provisions
  the student AND starts a 60-minute cloudflared quick tunnel in the same
  action, returning a single ready-to-send login URL.
- **No PUBLIC_PLAYGROUND_URL repoint** — the tunnel does NOT rewrite `.env`.
  The external login URL is composed in-memory from the live tunnel hostname
  captured at provision time: `https://<random>.trycloudflare.com/?token=<t>`.
  On-campus (non-external) adds get the normal campus-IP token URL from
  `PUBLIC_PLAYGROUND_URL`. `.env` is never mutated; no revert logic.
- **Login link shown** — after provisioning, the result panel shows a
  copyable class-token URL (`/?token=…`).
- **Single-student provisioner** — `scripts/class-skeleton.ts` cannot add one
  student safely: its `writeContainerConfig` overwrites EVERY student's
  `container.json`. A new `provisionStudent()` touches only the new folder.
  Shared per-student primitives (persona text, container-config builder,
  inherited-skills, class-shared symlink) are lifted into a shared module so
  the button-added student is byte-identical to a bulk-added one.

## Current-state facts (verified)
- Students `student_01`–`student_12` + `ta_01` exist → next slot is
  **`student_13`** (folder zero-padded 2-digit).
- A provisioned student = 5 artifacts:
  1. `agent_groups` row (`agent_provider:'codex'`, `model:'gpt-5.4-mini'`)
  2. `groups/student_NN/` — `CLAUDE.local.md` (persona), `CLAUDE.md`,
     `.class-shared.md` symlink → `data/class-shared-students.md`
  3. `groups/student_NN/container.json` (codex, inherited skills, kb/wiki mounts)
  4. `classroom_roster` row — `email → user_id 'class:student_NN'`, `agent_group_id`
  5. `agent_group_members` row — `'class:student_NN' → ag_xxx` (this is what
     `getPlaygroundAgentForUser` resolves through)
- kb/wiki mount paths come from `data/class-config.json` (`{kb,wiki,students…}`).
- Class-token sign-in goes through PIN-2FA (`/add-classroom-pin` active):
  `/?token=` → `/login/pin?token=` → 6-digit PIN emailed to the roster email
  via the host Gmail adapter. Guest needs that PIN — expected, not a blocker.
- `cloudflared` 2026.5.0 installed at `/opt/homebrew/bin/cloudflared`.
- Playground server runs in-host on `PLAYGROUND_PORT` (3002), auto-started by
  the classroom module's `onHostReady` hook.

## Status: implemented 2026-05-20 — pending operator deploy + live test.

## Phase 1 — Single-student provisioner  ✅
- [x] `src/class-student-provision.ts`: lifted `STUDENT_PERSONA`,
      `STUDENT_CLAUDE_MD`, `classSharedStudentMd`, `inheritedSkills`,
      `makeContainerConfig` out of `class-skeleton.ts`; added
      `nextStudentFolder()` + `provisionStudent({name,email,addedBy})`.
- [x] `scripts/class-skeleton.ts` now imports the lifted primitives
      (bulk path unchanged — typecheck + suite green).
- [x] Duplicate-email guard lives in `handleAddStudent`.
- [x] `provisionStudent` appends to `data/class-config.json` `students[]`.
- [x] Tests: `nextStudentFolder` selection. (Full FS-writing `provisionStudent`
      test skipped on purpose — would pollute the real `groups/`; the
      "writes exactly one container.json" safety property is structural.)

## Phase 2 — Guest tunnel module  ✅
- [x] `src/class-tunnel.ts` — `startGuestTunnel()` / `getGuestTunnel()` /
      `stopGuestTunnel()`, host-process singleton, 60-min auto-kill, reuse
      if already up. `cloudflared --url http://localhost:<PLAYGROUND_PORT>`
      (bind host defaults to 0.0.0.0 → localhost reachable).
- [x] `parseTunnelUrl()` pure fn + unit tests.

## Phase 3 — API  ✅
- [x] `src/channels/playground/api/students-admin.ts` —
      `handleAddStudent` / `handleGetTunnel` / `handleStopTunnel`.
      External adds compose `<tunnelUrl>/?token=`; non-external use the
      campus `PUBLIC_PLAYGROUND_URL`. Tunnel failure ≠ provisioning failure.
- [x] Routes wired in `api-routes.ts`: `POST /api/admin/students`,
      `GET /api/admin/tunnel`, `POST /api/admin/tunnel/stop`.
- [x] Tests: owner gate (403), bad input (400), duplicate email (409).

## Phase 4 — Home tab UI  ✅
- [x] `tabs/home.js` — owner-only "Add a student" card: name + email +
      "external guest" checkbox; result panel with copyable login link and
      tunnel status + Stop button.
- [x] `style.css` — `.home-form` / `.as-link*` / `.add-student-result`.

## Verify  ✅ (automated) / ⏳ (live)
- [x] `pnpm run build` + `tsc -p tsconfig.scripts.json` clean.
- [x] `pnpm test` — 835 passed; `format:check` + eslint clean.
- [ ] Live: deploy (restart host) → instructor loads Home tab → "Add a
      student" card visible; non-external add appears in Students roster;
      external add returns a working trycloudflare link.

## Notes / caveats
- This is a production-adjacent checkout (Clemson class). Implement + build +
  unit-test here; the service restart / live deploy and any live tunnel test
  are the operator's to run.
- Quick-tunnel URL is random per start and dies on host restart — fine for a
  60-min feedback window.
- The class-token URL is a bearer credential — revoke (`ncl class-token
  revoke --email`) when the feedback round ends.
- PIN-2FA: external guest needs the emailed 6-digit code; depends on the host
  Gmail adapter being configured.
