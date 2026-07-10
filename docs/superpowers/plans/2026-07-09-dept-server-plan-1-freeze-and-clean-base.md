# Department Server Plan 1: Freeze & Clean Base

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the classroom install (branch + verified data snapshot), strip the dependency-closed classroom-only code, and boot this repo as a clean department-server base with a fresh DB.

**Architecture:** This repo transforms in place (spec: `docs/superpowers/specs/2026-07-09-department-agent-server-design.md`). Classroom survives as the `classroom-freeze` branch plus a runtime-state tarball. The live install currently runs the `industryai_seminar` scenario, so classroom scenario code is dormant — deletions here are of never-loaded or classroom-surface-only code. Files with generic logic but classroom names (`class-login-tokens`, `class-login-pins`, `class-telegram-pair`, `class-playground-gate`, `class-container-env`, `user-provider-resolver`, `gws-*`, `student-creds-paths`, `student-google-auth`, `class-config`, migrations `016`/`module-class-login-*`/`module-class-telegram-pair`) are **NOT touched in this plan** — they get renamed/rewired in Plans 3–5 when each is reworked.

**Tech Stack:** Node + pnpm host (`pnpm run build` = tsc, `pnpm test` = vitest), Bun container tree (untouched in this plan), launchd service, Apple Container runtime.

## Global Constraints

- Working directory: `/Users/admin/projects/nanoclaw`. Do NOT touch `~/projects/nanoclaw_personal` (separate live install).
- launchd service label: `com.nanoclaw-v2-581fefa4` (NOT the generic `com.nanoclaw` in CLAUDE.md).
- Run `pnpm run build` yourself after every code change and read the output — vitest tolerates TS errors that tsc rejects.
- `data/`, `groups/`, `.env` are gitignored runtime state — snapshot before deleting anything under them.
- `data/class-config.json` contains real student names from a prior class run — it must end up in the snapshot and off the working disk.
- Ad-hoc DB queries: `pnpm exec tsx scripts/q.ts <db> "<sql>"` (never the `sqlite3` CLI).
- The service stays STOPPED from Task 3 until Task 8 boots the fresh base.
- Every commit message ends with the Co-Authored-By + Claude-Session trailer used by this session.

---

### Task 1: Commit the pending working tree

The freeze must capture the install's true current state. `git status` shows modified `config/playground-seats.json`, `container/CLAUDE.md`, `container/skills/make-website/SKILL.md`, `src/channels/playground/public/tabs/skills.js`, and untracked `.codegraph/`.

**Files:**
- Modify: `.gitignore` (append `.codegraph/`)
- Commit: the four modified files listed above

**Interfaces:**
- Produces: a clean `git status` so Task 2's branch point is unambiguous.

- [ ] **Step 1: Ignore the codegraph index**

```bash
echo ".codegraph/" >> .gitignore
```

- [ ] **Step 2: Review and commit pending changes**

```bash
git diff --stat
git add .gitignore config/playground-seats.json container/CLAUDE.md container/skills/make-website/SKILL.md src/channels/playground/public/tabs/skills.js
git commit -m "chore: commit pending seminar-install state before classroom freeze"
```

- [ ] **Step 3: Verify clean tree**

Run: `git status --porcelain`
Expected: empty output.

### Task 2: Freeze branch + tag, pushed

**Files:** none (git refs only).

**Interfaces:**
- Produces: branch `classroom-freeze` and tag `classroom-2026-07` at the same commit, on origin. August revival point.

- [ ] **Step 1: Create branch and tag**

```bash
git branch classroom-freeze
git tag classroom-2026-07
```

- [ ] **Step 2: Push both**

```bash
git push origin classroom-freeze classroom-2026-07
```

- [ ] **Step 3: Verify on remote**

Run: `git ls-remote origin classroom-freeze classroom-2026-07`
Expected: two lines, same SHA, matching `git rev-parse HEAD`.

### Task 3: Stop service, snapshot runtime state, verify restorable

**Files:**
- Create: `~/archives/classroom-2026-07.tar.gz` (outside the repo)

**Interfaces:**
- Produces: verified tarball containing `data/`, `groups/`, `.env`. Tasks 7–8 may delete/replace those directories only after this task's verify step passes.

- [ ] **Step 1: Stop the service**

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
launchctl list | grep nanoclaw
```

Expected: the grep shows no `com.nanoclaw-v2-581fefa4` entry (personal install's label may still appear — leave it alone).

- [ ] **Step 2: Snapshot**

```bash
mkdir -p ~/archives
tar -czf ~/archives/classroom-2026-07.tar.gz -C /Users/admin/projects/nanoclaw data groups .env
```

- [ ] **Step 3: Verify the archive is restorable**

```bash
mkdir -p /private/tmp/classroom-restore-test
tar -xzf ~/archives/classroom-2026-07.tar.gz -C /private/tmp/classroom-restore-test
pnpm exec tsx scripts/q.ts /private/tmp/classroom-restore-test/data/v2.db "SELECT COUNT(*) FROM users"
ls /private/tmp/classroom-restore-test/groups | head
test -f /private/tmp/classroom-restore-test/data/class-config.json && echo "class-config captured"
rm -rf /private/tmp/classroom-restore-test
```

Expected: user count > 0, group folders listed, `class-config captured` printed. **Do not proceed past this task until all three checks pass.**

### Task 4: Delete the classroom scenario profile

Dormant code — `ACTIVE_SCENARIO=industryai_seminar` (`.env` line ~20), and `src/scenarios/index.ts` loads only the active profile.

**Files:**
- Delete: `src/scenarios/classroom/` (entire directory)
- Modify: `src/scenarios/index.ts` (~line 18: remove the `classroom:` loader entry)

**Interfaces:**
- Consumes: nothing.
- Produces: `loaders` map in `src/scenarios/index.ts` containing only `industryai_seminar`. `src/class-config.ts` loses its classroom-scenario consumer but survives (still imported by `class-playground-gate.ts` and `api/usage.ts` — rewired in a later plan).

- [ ] **Step 1: Delete and unwire**

```bash
git rm -r src/scenarios/classroom/
git rm -r .claude/skills/add-classroom .claude/skills/add-classroom-auth .claude/skills/add-classroom-gws .claude/skills/add-classroom-pin
```

(The classroom *install skills* go with the scenario — the PIN and login-token *code* they installed stays until Plans 3–5 rewire it. `add-karpathy-llm-wiki` is generic; keep it.)

In `src/scenarios/index.ts` remove this line from the `loaders` map:

```ts
  classroom: () => import('./classroom/index.js'),
```

- [ ] **Step 2: Build and test**

Run: `pnpm run build && pnpm test`
Expected: build clean; vitest green (classroom scenario tests were deleted with the directory; if any *other* test file imports `scenarios/classroom`, delete that test file too — it tests deleted code).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: delete classroom scenario profile (frozen on classroom-freeze)"
```

### Task 5: Delete the enrollment surface

Self-serve "enrollment day" passcode claim — classroom-only UX with no department future (dept is admin-provisioned invites).

**Files:**
- Delete: `src/class-enrollment-passcode.ts`, `src/class-enrollment-passcode.test.ts`, `src/channels/playground/api/enrollment.ts`, `src/db/migrations/module-class-enrollment-passcode.ts`
- Modify: `src/db/migrations/index.ts` (remove the module-class-enrollment-passcode registration), whatever file mounts `api/enrollment.ts` routes (find with the grep below), and the frontend card that calls the enrollment endpoint

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no `enrollment` symbol anywhere in `src/`. Migration registry no longer references the deleted module. (Fresh DBs simply never get the passcode table; migration `016-classroom-roster` is NOT touched here — `db/classroom-roster.ts` still has live consumers until Plan 4.)

- [ ] **Step 1: Find every reference before deleting**

```bash
grep -rn "enrollment" src/ --include='*.ts' -l
grep -rn "enrollment" src/channels/playground/public/ -l
```

- [ ] **Step 2: Delete files and unwire every hit from Step 1**

```bash
git rm src/class-enrollment-passcode.ts src/class-enrollment-passcode.test.ts src/channels/playground/api/enrollment.ts src/db/migrations/module-class-enrollment-passcode.ts
```

Then: remove the migration registration line in `src/db/migrations/index.ts`; remove the route mounts + import lines wherever Step 1's grep found them (expected: `api-routes.ts` or `server.ts`); in the frontend file(s) found by Step 1's second grep, delete the enrollment card/section (the DOM block plus its fetch call) — nothing else in that file.

- [ ] **Step 3: Verify zero references, build, test**

```bash
grep -rn "enrollment" src/ ; pnpm run build && pnpm test
```

Expected: grep returns nothing; build + tests green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: delete classroom enrollment-passcode surface"
```

### Task 6: Delete roster admin + shared-class-base surface

The "Add student" roster CRUD and the shared class persona file. Department provisioning (Plan 3) replaces this with the invite flow; `class-student-provision.ts` is the reference implementation Plan 3 will resurrect *from the freeze branch* — delete it here.

**Files:**
- Delete: `src/channels/playground/api/students-admin.ts`, `src/channels/playground/api/class-base.ts`, `src/class-student-provision.ts`, `src/class-student-provision.test.ts`
- Modify: `src/channels/playground/api-routes.ts` (imports at lines ~125–126; route blocks at ~763–777 for class-base and the students-admin mounts), plus frontend cards calling these endpoints (expected in `public/tabs/home.js`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `api/class-controls.ts` and its routes REMAIN (imported at api-routes.ts line 123 and consumed by `user-provider-resolver.ts` — Plan 4's job). `skeleton-mount-registry.ts` becomes a zero-registrant no-op but stays.

- [ ] **Step 1: Map references**

```bash
grep -rn "students-admin\|class-base\|class-student-provision\|handleAddStudent\|handleGetClassBase\|handlePutClassBase\|handleGetTunnel\|handleStopTunnel" src/ --include='*.ts' --include='*.js'
```

- [ ] **Step 2: Delete and unwire**

```bash
git rm src/channels/playground/api/students-admin.ts src/channels/playground/api/class-base.ts src/class-student-provision.ts src/class-student-provision.test.ts
```

In `api-routes.ts`: remove the two import lines and every route block referencing the deleted handlers (GET/PUT `/api/class-base`, the students-admin mounts). In the frontend files found in Step 1 (expected `home.js`): delete the roster-admin and class-base cards — the DOM blocks and their fetch calls only. Do NOT touch `class-controls` imports/routes/cards.

- [ ] **Step 3: Verify, build, test**

```bash
grep -rn "class-base\|students-admin\|class-student-provision" src/ ; pnpm run build && pnpm test
```

Expected: grep empty; build + tests green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: delete classroom roster-admin and shared-class-base surface"
```

### Task 7: Purge classroom runtime data from the working disk

All three items are inside the verified Task 3 snapshot.

**Files:**
- Delete (plain `rm`, all gitignored): `data/class-config.json`, `data/class-shared-students.md`, `data/student-google-auth/`

**Interfaces:**
- Consumes: Task 3's verified snapshot (hard prerequisite).
- Produces: no personally-identifying classroom data on the working disk. `class-config.ts` tolerates a missing `data/class-config.json` (fresh installs never have one) — Task 8's boot verifies.

- [ ] **Step 1: Confirm snapshot exists, then delete**

```bash
test -f ~/archives/classroom-2026-07.tar.gz && rm -f data/class-config.json data/class-shared-students.md && rm -rf data/student-google-auth
```

- [ ] **Step 2: Verify**

Run: `ls data/ | grep -i class ; ls data/ | grep -i student`
Expected: no output from either grep.

### Task 8: Fresh-DB boot as the department base

**Files:**
- Modify: `config/playground-seats.json` (trim to Owner + one test member seat)
- Move aside: `data/v2.db` and `data/v2-sessions/` (fresh DB is created by migrations on boot)
- Keep: `groups/` as-is (`_default_participant`, `owner_01`, `user_01`–`03` are generic seminar-shaped scaffolding the dept pilot reuses; delete the `delete-*`/test scratch dirs only)

**Interfaces:**
- Consumes: Tasks 4–7 complete (classroom-free codebase).
- Produces: running dept base — fresh `data/v2.db` with all migrations applied, playground reachable at `https://gcworkflow.clemson.edu` (Caddy → 3002), owner seat can chat on the dept OpenAI key. This is Plan 2–5's starting state.

- [ ] **Step 1: Move the old DB aside and trim seats**

```bash
mkdir -p data/pre-dept-archive
mv data/v2.db data/pre-dept-archive/ 2>/dev/null
mv data/v2-sessions data/pre-dept-archive/ 2>/dev/null
ls groups/ | grep '^delete-' | xargs -I{} rm -rf groups/{}
```

Edit `config/playground-seats.json`: keep the existing `password` value and exactly two seats — the existing Owner seat (`folder: "owner_01"`, `role: "owner"`) and one member seat (`folder: "user_01"`, `role: "member"`). Remove the other member seats.

- [ ] **Step 2: Boot and watch migrations**

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
sleep 5
tail -40 logs/nanoclaw.log
tail -20 logs/nanoclaw.error.log
```

Expected: migration lines through the latest version, no errors. `data/v2.db` exists. Verify schema: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT MAX(version) FROM schema_version"` matches the count of registered migrations.

- [ ] **Step 3: End-to-end owner chat turn**

Open `https://gcworkflow.clemson.edu` (via the 130.127.162.180:8088 Caddy proxy — never 127.0.0.1). Claim the Owner seat via the seat picker + password. Send one chat message; expect an agent reply (runs on the `.env` `OPENAI_API_KEY` dept key through the credential proxy).

**If seat claim fails** because seat provisioning depended on deleted code: `git show classroom-freeze:src/class-student-provision.ts` to inspect the provisioning primitive and restore the minimal path it used — then note the coupling in the plan-1 completion report so Plan 3 addresses it properly.

- [ ] **Step 4: Verify browser console + logs are clean of dead-endpoint calls**

Open the browser devtools console on the playground home tab.
Expected: no 404s for `/api/class-base`, `/api/enrollment*`, or students-admin endpoints (their cards were removed in Tasks 5–6). A 200 on `/api/class-controls` is expected — it survives until Plan 4.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: department base — trimmed seats, fresh-DB boot verified"
```

### Task 9: Update state.md and push

**Files:**
- Modify: `state.md` (Goal, Current arc, Decision log)

**Interfaces:**
- Consumes: everything above, done and verified.
- Produces: state.md reflecting the department-server arc, main pushed.

- [ ] **Step 1: Edit state.md stable sections**

Update **Goal** to describe the department agent server (~15 faculty/staff, per-user agents, web + Telegram, ChatGPT-per-user + dept-key backstop). Update **Current arc** to "Plan 1 (freeze & clean base) complete; next: Plan 2 ports from personal repo" with a pointer to the spec. Append a **Decision log** entry dated 2026-07-09: classroom frozen at `classroom-freeze` / `classroom-2026-07` + snapshot at `~/archives/classroom-2026-07.tar.gz`; repo transforms in place into the department server; classroom revives on a new box in August via `/install-handoff`.

- [ ] **Step 2: Commit (pre-commit hook regenerates the volatile section) and push**

```bash
git add state.md && git commit -m "docs(state): department-server arc — classroom frozen, Plan 1 complete"
git push origin main
```

- [ ] **Step 3: Repo rename (owner action)**

Ask the owner for the department-neutral repo name (spec §1.7, e.g. `nanoclaw-dept`) and have them rename `chiptoe-svg/nanoclaw_gccourse` in GitHub settings (GitHub redirects the old URL). Then update the local remote:

```bash
git remote set-url origin https://github.com/chiptoe-svg/<new-name>.git
git ls-remote origin main >/dev/null && echo "remote OK"
```

---

## Roadmap (subsequent plans, each written after the prior lands)

- **Plan 2 — Ports from personal repo:** pi harness reconciliation (best-of-both diff), `hermes-selflearning` + `self-customize`, `agents-compose` size guard, `fetch_url_to_workspace`, Apple Container orphan-cleanup fix.
- **Plan 3 — Invite & identity:** provisioning primitive (resurrect pattern from `classroom-freeze`), Resend invite email, rename/rewire `class-login-tokens` + `class-login-pins` (+ their `module-class-*` migrations) to per-user invites, department scenario naming; revert dev auth posture (PLAYGROUND_AUTH_BYPASS, seat password).
- **Plan 4 — Provider auth & backstop:** rewire `user-provider-resolver` (drop `class-controls`/`classroom-roster` deps — then delete those + migration 016 + `config/class-controls.json`), per-user ChatGPT paste-back OAuth, backstop warning events + usage surfacing.
- **Plan 5 — Homepage & channels:** §5 reorg of the playground (rollups, status strip, `home.js` rebuild), admin roster view, Telegram linking (rewire `class-telegram-pair`), rename remaining classroom-flavored files (`class-playground-gate`, `class-container-env`, `student-creds-paths`, `student-google-auth`, `gws-token` naming).
