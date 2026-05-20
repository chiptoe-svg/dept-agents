---
name: add-classroom
description: Provision an instructor-owned bot that hosts a class with four role tiers — admin, instructor(s), TA(s), and students. Each role has its own agent group, persona, and permissions. Wiki commits attributed to real members. Role detection is by folder prefix (student_/ta_/instructor_). Layered with /add-classroom-gws (Drive folders) and /add-classroom-auth (per-student ChatGPT subscription).
---

# Add Classroom (base)

Bulk-provision a class with four role tiers against a single bot:

- **Admin** = the existing instance owner. Single global user.
- **Instructor** = global admin role. Multiple supported.
- **TA** = scoped admin on every student/TA agent group (whole-class).
  Each TA gets their own `ta_NN` agent group.
- **Student** = member of their own `student_NN` group only.

The base skill installs:

- `class-skeleton.ts` — bulk provisioner with `--instructors`,
  `--tas`, and student `--names` CLI flags.
- Three pair consumers (one per role, all idempotent) that stamp
  metadata + grant the right roles + send a short greeting.
- Role-aware playground lockdown: students get persona-only edits;
  TAs and instructors can edit non-persona files on student drafts.
- Per-student git identity injection so wiki commits show the real
  member name + email.
- A class-shared markdown file at `data/class-shared-students.md`
  symlinked into every student folder. Default content: Socratic-tutor
  stance + per-user web-hosting instructions (use
  `/var/www/sites/<your-folder>/<sitename>/` to avoid clobbering
  classmates). Instructor edits this one file → propagates to all
  students.

Optional layered skills (run after the base is installed):

- `/add-classroom-gws` — Google Drive folder per student via the
  instructor's existing Google OAuth.
- `/add-classroom-auth` — per-student Codex OAuth so students burn
  their own ChatGPT subscription quota instead of the instructor's.

## Prerequisites

- `/add-agent-playground` should be installed. The classroom feature
  works without it, but the playground lockdown gate has nothing to
  do until the playground is wired in. The skill warns if absent.
- `/add-telegram` (or another DM-capable channel) installed and
  paired. The class feature uses the channel-agnostic pair-consumer
  registry, but you need at least one channel that handles wire-to
  pairings (Telegram is what's documented in the smoke-test runbook).
- **Phase 12.1 main-side change**: the playground gate signature
  was extended to take a `userId` in context for role-aware
  decisions. If your `main` was last synced before May 6 2026,
  pull main first or merge in commit `0441eaf` so the role-aware
  gate actually sees who's editing.

## Install

This skill copies the base classroom files from the
`origin/classroom` sibling branch and appends imports.

### Pre-flight (idempotent — safe to re-run)

Skip to **Provision** if all of these are already in place:

- `src/class-config.ts`, `src/class-pair-greeting.ts`,
  `src/class-pair-instructor.ts`, `src/class-pair-ta.ts`,
  `src/class-playground-gate.ts`, `src/class-container-env.ts`,
  `src/class-codex-auth.ts`, `src/class-login-tokens.ts`,
  `src/db/migrations/module-class-login-tokens.ts`,
  `src/cli/resources/class-tokens.ts`,
  `scripts/class-skeleton.ts`, `scripts/class-skeleton-extensions.ts`
  exist
- `src/index.ts` contains imports for `class-pair-greeting`,
  `class-pair-instructor`, `class-pair-ta`, `class-playground-gate`,
  `class-container-env`, `class-codex-auth`, and `class-login-tokens`
- `src/db/migrations/index.ts` contains `moduleClassLoginTokens` in
  its migrations array
- `src/cli/resources/index.ts` contains `import './class-tokens.js';`
- `.env` contains a `CLASS_OPENAI_API_KEY=` line (value may be empty
  if you're configuring the key later — see step 5 below)
- `.env` contains a `PUBLIC_PLAYGROUND_URL=` line set to the externally
  reachable playground URL (e.g. `http://192.168.1.50:3002`) so
  `ncl class-tokens` prints student URLs that actually work

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 2. Copy the base classroom files

```bash
git show origin/classroom:src/class-config.ts             > src/class-config.ts
git show origin/classroom:src/class-config.test.ts        > src/class-config.test.ts
git show origin/classroom:src/class-pair-greeting.ts      > src/class-pair-greeting.ts
git show origin/classroom:src/class-pair-instructor.ts    > src/class-pair-instructor.ts
git show origin/classroom:src/class-pair-ta.ts            > src/class-pair-ta.ts
git show origin/classroom:src/class-playground-gate.ts    > src/class-playground-gate.ts
git show origin/classroom:src/class-container-env.ts      > src/class-container-env.ts
git show origin/classroom:src/class-container-env.test.ts > src/class-container-env.test.ts
git show origin/classroom:src/class-codex-auth.ts         > src/class-codex-auth.ts
git show origin/classroom:src/class-codex-auth.test.ts    > src/class-codex-auth.test.ts
git show origin/classroom:src/class-login-tokens.ts                       > src/class-login-tokens.ts
git show origin/classroom:src/class-login-tokens.test.ts                  > src/class-login-tokens.test.ts
git show origin/classroom:src/db/migrations/module-class-login-tokens.ts  > src/db/migrations/module-class-login-tokens.ts
git show origin/classroom:src/cli/resources/class-tokens.ts               > src/cli/resources/class-tokens.ts
git show origin/classroom:scripts/class-skeleton.ts       > scripts/class-skeleton.ts
git show origin/classroom:scripts/class-skeleton-extensions.ts > scripts/class-skeleton-extensions.ts
mkdir -p docs
git show origin/classroom:docs/class-setup.md             > docs/class-setup.md
mkdir -p plans
git show origin/classroom:plans/class.md                  > plans/class.md
git show origin/classroom:plans/class-smoke-test.md       > plans/class-smoke-test.md
```

### 3. Append the self-registration imports

Append these five lines to `src/index.ts` (skip lines already
present). They go in the same area as the `import './channels/index.js'`
and `import './modules/index.js'` blocks:

```typescript
import './class-pair-greeting.js';
import './class-pair-instructor.js';
import './class-pair-ta.js';
import './class-playground-gate.js';
import './class-container-env.js';
import './class-codex-auth.js';
import './class-login-tokens.js';
```

Append to `src/db/migrations/index.ts` (skip if present). The import goes
in the import block at the top; the array entry goes at the **end** of
the `migrations` array (preserves ordering — the trunk migrations stay
first, classroom additions tack on):

```typescript
import { moduleClassLoginTokens } from './module-class-login-tokens.js';
// ...
const migrations: Migration[] = [
  // ... existing trunk migrations ...
  moduleClassLoginTokens,
];
```

Append to `src/cli/resources/index.ts` (skip if present):

```typescript
import './class-tokens.js';
```

### 4. Edit the skeleton extensions barrel

The base skill ships `scripts/class-skeleton-extensions.ts` as
EMPTY (no extensions). The gws and auth skills append their own
imports. If the file from step 2 has any imports already, leave
them — they're from a previously-installed layer.

If the file you copied has the gws import line, leave it. The
skill is idempotent and the import only takes effect when the
referenced file exists (i.e., gws is installed).

### 5. Configure the class LLM credential pool (`CLASS_OPENAI_API_KEY`)

Class agent groups (folder prefix `student_` / `ta_` / `instructor_`)
consume a class-shared OpenAI API key, not the instructor's personal
ChatGPT subscription. `src/class-codex-auth.ts` reads this value from
`.env` at host startup and writes `data/class-codex-auth.json` (the
api-key-mode shape codex CLI expects).

**Check current state:**

```bash
grep -E '^CLASS_OPENAI_API_KEY=' .env || echo "(not set)"
```

If unset, **ask the user** for the class key (one OpenAI API key per
class, instructor-owned, billed to the class budget). If they don't
have one yet, walk them through:

> Go to https://platform.openai.com/api-keys, create a key for this
> class (name it something memorable like "<class-name> spring 2026"),
> and paste it below. Make sure the project has API credits funded —
> students consume directly from this pool.

Append (or replace) the line in `.env`:

```bash
CLASS_OPENAI_API_KEY=sk-proj-...
```

If a value is already present **and the user is re-running for a new
semester / rotating the key**, ask them whether to update it. Replace
the existing line on confirm. (Manual sed/edit; the skill doesn't
silently overwrite — that's a foot-gun.)

**Fallback note:** if the key is left unset, class agent groups fall
back to the instructor's personal `~/.codex/auth.json` (ChatGPT OAuth)
via the codex resolver chain. Useful as a temporary backup if the API
path breaks, but expect the instructor's ChatGPT plan to absorb the
cost. Set the key for the steady-state class deploy.

**Local-LLM alternative:** the class can run entirely off a local
OpenAI-compatible server (mlx-omni-server / Ollama / LM Studio) — no
paid API at all. See [`docs/local-llm.md`](../../../docs/local-llm.md)
for the runbook. Set `OPENAI_BASE_URL=http://127.0.0.1:<port>` +
`OPENAI_API_KEY=local` in `.env` and the credential proxy routes
`/openai/*` to your local model instead of `api.openai.com`. The
`CLASS_OPENAI_API_KEY` step above becomes optional — just leaving it
unset works fine when `OPENAI_BASE_URL` points local. (You still want
a key set for cloud-fallback if your local server is down — pick one
approach as the primary; the other is a backup.)

### 5b. Configure the public playground URL (`PUBLIC_PLAYGROUND_URL`)

Class login tokens get distributed as URLs like
`http://<host>:3002/?token=<random>`. The host part needs to be the
URL students will actually reach — for a Mac Studio on the LAN, that's
the LAN IP (e.g. `http://192.168.1.50:3002`); for a public deploy,
the domain.

**Ask the user** for the externally-reachable playground URL. Append
to `.env` (skip if already present):

```bash
PUBLIC_PLAYGROUND_URL=http://<host>:3002
```

The default if unset is `http://localhost:3002` — useless for students,
but a harmless placeholder so the CLI doesn't crash printing URLs.
Rotation: edit `.env`, restart the host; future `ncl class-tokens`
output picks up the new base.

### 5c. (Optional) Wire Resend for student self-serve link recovery

The `/login` page includes a "Lost your link?" form. When a student
enters their email, the server looks them up in `classroom_roster`,
rotates their token, and emails the fresh URL — if Resend is
configured. Without Resend, the form returns a generic "contact
your instructor" message and the student has to ask you to run
`ncl class-tokens rotate --email <e>` manually.

To enable self-serve recovery, add to `.env` (skip if already
present from `/add-resend`):

```bash
RESEND_API_KEY=re_...                    # from https://resend.com/api-keys
RESEND_FROM_ADDRESS=class@your-domain    # must be a verified Resend sender
RESEND_FROM_NAME=Class Bot               # optional; shown as the From name
```

The Resend channel adapter (`/add-resend`) uses these same env vars,
so if you've already installed it, you're done — no extra config.
You do NOT need to install the Resend *channel* just for lost-link
recovery; the recovery flow calls the Resend API directly.

Verify after restart:

- Visit `${PUBLIC_PLAYGROUND_URL}/login`, expand "Lost your link?",
  enter a roster email, click Send. The page should show a generic
  success message.
- Check the student's inbox for an email from
  `RESEND_FROM_ADDRESS`. The link should be a fresh
  `?token=...` URL that supersedes any prior token.
- Anti-enumeration check: enter a non-roster email — same generic
  success message, no email actually sent. (Logs at
  `logs/nanoclaw.log` confirm: "Lost-link recovery: no roster
  entry".)

### 6. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

Both should be green. If `pnpm test` reports failures, diff against
`origin/classroom` to see what's drifted.

### 7. Restart the service

```bash
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

Verify `data/class-codex-auth.json` was written (when key was set):

```bash
ls -l data/class-codex-auth.json
```

And the log line at startup:

```bash
grep -i 'class.codex\|CLASS_OPENAI' logs/nanoclaw.log | tail -5
```

You should see either "CLASS_OPENAI_API_KEY not set — class codex
resolver will fall through to instructor OAuth" (if you left it unset)
or "Class Codex auth.json written" (if you set the key).

## Provision a class

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 16 \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy,Kenneth,Leo,Mia,Noor,Oscar,Pat" \
  --tas "Mara,Nikhil" \
  --instructors "Prof.Smith" \
  --kb /srv/class-kb \
  --wiki /srv/class-wiki
```

The `--tas` and `--instructors` flags are optional (default to
none, in which case only students get provisioned). Comma-separated
names; one folder per name (`ta_01`, `ta_02`, `instructor_01`, etc.).

This creates per-role group folders with starter CLAUDE.md +
CLAUDE.local.md + container.json (KB ro mount, wiki rw mount),
agent_groups rows, four-digit pairing codes via the `wire-to`
flow, and a `class-roster.csv` with a role column.

The first run also writes `data/class-shared-students.md` (default:
Socratic-tutor stance + per-user web-hosting instruction). Each
student folder's `.class-shared.md` is symlinked to it, so editing
that one file changes the class-wide stance for every student.

KB and wiki paths must be in
`~/.config/nanoclaw/mount-allowlist.json` or the host will refuse
to spawn containers.

See `docs/class-setup.md` for the full instructor README.

## Distribute student login URLs

Each roster row gets a durable URL that logs the student into the
playground home page. The instructor mints + distributes; the student
bookmarks. No Google OAuth required for Mode A — token = identity.

**Mint one URL at a time:**

```bash
ncl class-tokens issue --email alice@example.com
# → { ok: true, email: ..., user_id: ..., url: "http://<host>:3002/?token=..." }
```

**Mint URLs for everyone after class-skeleton ran:**

```bash
# Loop over roster emails (extracted via ncl users list or the CSV file).
for email in $(cut -d, -f1 /srv/class-roster.csv | tail -n +2); do
  ncl class-tokens issue --email "$email"
done
```

Paste the resulting URLs into your existing distribution channel —
class Drive doc, Canvas roster, individual emails. Anyone with the URL
can log in **as that student**, so treat it like a password.

**A student lost their URL:**

```bash
ncl class-tokens rotate --email alice@example.com
```

Revokes any prior tokens for Alice and mints a fresh one. Print the new
URL and send it via your usual channel. Alice's old URL stops working
immediately.

**Next semester:**

Just re-run the `for ... rotate` loop with the new roster. Old students'
tokens become inactive; new students get fresh ones. Or wipe the table
with `pnpm exec tsx scripts/q.ts data/v2.db "UPDATE class_login_tokens
SET revoked_at = datetime('now') WHERE revoked_at IS NULL"` and start
clean.

## What members experience after pairing

Each member DMs the bot:

```
<their-pairing-code> <their-email>
```

The bot replies based on the role of the folder the code targeted:

- **Student** (`student_NN`): "Hi Alice! Welcome to class. Send
  /playground any time to customize my personality and style."
- **TA** (`ta_NN`): "Hi Mara! You're set up as a TA for this class.
  You have admin access to every student's agent group..."
- **Instructor** (`instructor_NN`): "Hi Prof.Smith! You're set up
  as an instructor for this class. You have global admin..."

If `/add-classroom-gws` is installed, a Drive folder URL follows.
If `/add-classroom-auth` is installed, an auth-link URL follows.

The role grants happen at pair time:

- Instructor → global `admin` role.
- TA → scoped `admin` on every `student_*` and every other `ta_*`
  in the class (whole-class).
- Student → `agent_group_members` row on their own student folder.

## Customize the personas

Each role's default persona is in `scripts/class-skeleton.ts`
(`STUDENT_PERSONA`, `TA_PERSONA`, `INSTRUCTOR_PERSONA` template
literals). Per-member persona lives in
`groups/<folder>/CLAUDE.local.md` after provisioning — editable via
`/playground` (locked-down to persona-only edits for students;
admin-bypass for TAs and instructors).

The class-wide socratic stance lives in
`data/class-shared-students.md` and only applies to students. Edit
that one file; every student's next session picks it up.

## Where this fits in the deploy story

This skill installs the classroom **base**. For a complete
shared-classroom deploy, also run:

1. `/add-classroom-gws` — per-student Drive folders + shared-classroom
   ownership friction (`nanoclaw_owners` tag, hard-block on
   cross-student writes). The base GWS MCP infrastructure ships in
   trunk — no separate install step.

End-to-end guide: [`docs/shared-classroom.md`](../../../docs/shared-classroom.md).

`/add-classroom-auth` is for the **per-person classroom** deploy
shape (each student authorizes their own ChatGPT subscription) —
defer until you've validated the shared-classroom deploy first.
