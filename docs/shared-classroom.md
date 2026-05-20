# Shared classroom deploy guide

End-to-end guide for deploying a NanoClaw classroom where one
instructor owns the workspace and credentials, and students get
agents wired into a shared Google Drive + a shared LLM credit pool.
This is the simplest deployment shape — students bring nothing but
a personal email address and a bookmark.

Per-person classroom (where each student authorizes their own
Google + LLM provider) is a separate deploy mode tracked in
[Phase 2 of the master plan](../plans/master.md#phase-2--full-classroom-capability-per-person-accounts--labs).
This guide covers shared classroom only.

## What you get

| Component | Where it lives |
|---|---|
| Per-student Telegram (or other DM channel) agent | one agent group per student, isolated container |
| Per-student `student_NN/` workspace folder | host filesystem; mounted into the student's container |
| Class-shared instructions file | `data/class-shared-students.md`, symlinked into every student folder |
| Google Workspace access | one instructor OAuth; students see folders shared from the instructor's Drive |
| LLM credit pool | one OpenAI API key, instructor-funded, students consume from it transparently |
| URL-based login to the playground homepage | one durable URL per student; bookmark = identity, no Google OAuth needed |
| Wiki commits attributed to real students | per-student git identity injected at container spawn |
| TA + instructor roles | TA gets scoped-admin on all student groups; instructor gets global admin |

## Prerequisites

**Host machine:**
- macOS or Linux with Docker (or Apple Container on macOS) installed
- Node.js 20+ and pnpm 10+
- A reachable URL students can hit to load the playground homepage
  (LAN IP for local-network classes, public domain for hosted)
- Mount allowlist permits the KB and wiki paths you plan to use
  (`~/.config/nanoclaw/mount-allowlist.json`)

**Accounts the instructor needs:**
- A credential for your chosen AI-coding-CLI — either an Anthropic
  API key (if you pick Claude Code) or an OpenAI API key / ChatGPT
  subscription (if you pick Codex). `nanoclaw.sh` asks which CLI on
  first run; the AI-coding-CLI is the operator-side assistant for
  `/customize`, `/debug`, and setup recovery, separate from the
  runtime agent provider below.
- A Telegram bot (or any other DM channel — Slack, Discord, etc.)
- An OpenAI API key for the class LLM pool — this is the **runtime**
  credential that funds every student's agent. Codex (api-key mode)
  is the documented agent provider for shared classroom deploys
  because students consume directly from `CLASS_OPENAI_API_KEY`
  without per-student auth. (Alternative: a local OpenAI-compatible
  LLM server — see [local-llm.md](local-llm.md). Or use Claude as
  the runtime provider, but that requires per-student Anthropic
  keys or a shared key with no per-student attribution.)
- Google account with Drive access for the instructor (one OAuth
  authorization covers all class students in this mode)

**Skip-the-classroom alternative:** if you just want a single
personal assistant for yourself, you don't need this guide — run
`bash nanoclaw.sh` and you're done. Come back here when you want to
provision N students against the same bot.

## Deploy order

The six steps below are designed to be run in order on a fresh host.
Each step is idempotent and safe to re-run.

### 1. Base setup

```bash
git clone https://github.com/chiptoe-svg/nanoclaw_gccourse.git nanoclaw-classroom
cd nanoclaw-classroom
bash nanoclaw.sh
```

This walks you through: dependencies, the AI-coding-CLI picker
(Claude Code or Codex — your operator-side assistant for the rest
of this guide), the agent container build, the credential proxy,
the service unit, and your first DM channel.

**Pick Codex** when the CLI picker asks — the rest of this guide
assumes Codex is your AI-coding-CLI because the runtime agent
provider for the class is also Codex (one less context-switch for
the instructor). Claude Code works fine; you'll just be reading
about codex commands when you're using a different CLI.

**Pick Telegram** when prompted for a channel — every other shared-
classroom skill is documented against the Telegram flow. Other DM
channels work but are less-tested.

**At the end of setup, verify:**

```bash
systemctl --user status nanoclaw   # Linux
# launchctl list | grep nanoclaw     # macOS
```

The service should be active, and DMing your bot the trigger word
should produce a reply.

### 2. Install the agent playground

```
/add-agent-playground
```

This adds a web workbench used to manage student personas. The
classroom feature warns if it isn't installed because the role-aware
playground gate has nothing to gate against without it.

**Verify:** the playground server starts on port 3002 after the
host restart (`grep playground logs/nanoclaw.log | tail -5`).

### 3. Authorize Google Workspace access

The GWS MCP infrastructure — relay, server, and container-side
Docs/Sheets/Slides/Calendar/Gmail tools — ships in trunk; there is no
install step. Authorize the instructor's Google account if not
already done:

```bash
pnpm exec tsx scripts/gws-authorize.ts
# Opens an OAuth URL via a tmp file (so terminal wrapping doesn't
# break copy-paste). Authorize as the instructor's Google account.
# Credentials land at ~/.config/gws/credentials.json.
```

**Verify:**

```bash
ls -l ~/.config/gws/credentials.json   # exists, mode 0600
pnpm exec tsx scripts/q.ts data/v2.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gws%'"
```

**Linux + ufw gotcha:** if ufw is active, the GWS relay on port
3007 needs an explicit allow rule for docker0 traffic, or
containers can't reach it. Add the rule:

```bash
sudo ufw allow in on docker0 to any port 3007 proto tcp
```

(Port 3001 for the credential proxy already has an iptables ACCEPT
from earlier setup; 3007 is the one to add.)

### 4. Install the classroom base

```
/add-classroom
```

Provisions class infrastructure: role-aware pair consumers, the
class-shared instructions file, per-student git identity injection,
the class LLM credential pool wiring, and the URL-as-identity
login token system.

**During the skill run, you'll be prompted for two `.env` values:**

- **`CLASS_OPENAI_API_KEY`** — the class LLM pool key. Create one
  at https://platform.openai.com/api-keys, named for the class
  (e.g. `physics-101-spring-2026`). Fund the project with credits;
  students consume directly from this pool. The class-codex-auth
  module reads this on startup, writes `data/class-codex-auth.json`,
  and shadows the instructor's personal codex auth for class-shaped
  agent groups (folder prefix `student_/ta_/instructor_`).
  
  **Local-LLM alternative:** if you want zero API cost, run a local
  OpenAI-compatible server instead. Set `OPENAI_BASE_URL` in `.env`
  to your local server, leave `CLASS_OPENAI_API_KEY` empty. See
  [local-llm.md](local-llm.md) for the full runbook.

- **`PUBLIC_PLAYGROUND_URL`** — the URL students will actually
  reach. For a Mac Studio on your LAN: `http://192.168.1.50:3002`.
  For a public deploy: your domain. Login URLs minted later embed
  this value, so wrong value = broken bookmarks.

**Verify after the host restart:**

```bash
ls -l data/class-codex-auth.json
grep -i 'class.codex\|CLASS_OPENAI' logs/nanoclaw.log | tail -5
```

You should see either "Class Codex auth.json written" (key was set)
or "CLASS_OPENAI_API_KEY not set — class codex resolver will fall
through to instructor OAuth" (key was left empty).

### 5. Install the classroom Drive integration

```
/add-classroom-gws
```

Adds per-student Drive folders (created via instructor OAuth and
shared as Editor with each student's email), exposes each folder
at `/workspace/drive/` inside the student container via an rclone
bind mount, and installs the **Mode A ownership friction** primitive
— students can read each others' Docs/Sheets/Slides but can't
overwrite or delete them. Hard-blocked at the relay.

**Before running, ensure `rclone` is installed on the host.** Without
it, the bind mounts work but reference empty directories — agents
get no Drive content. See `docs/class-setup.md` for rclone setup.

**Verify:**

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder, drive_folder_id FROM agent_groups WHERE folder LIKE 'student_%'"
```

After provisioning students (next step), each row should have a
`drive_folder_id` populated.

### 6. Provision the class

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 16 \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy,Kenneth,Leo,Mia,Noor,Oscar,Pat" \
  --tas "Mara,Nikhil" \
  --instructors "Prof.Smith" \
  --kb /srv/class-kb \
  --wiki /srv/class-wiki
```

`--tas` and `--instructors` are optional. Names are comma-separated.
This creates per-role group folders (`student_01`, `student_02`, …,
`ta_01`, `instructor_01`), CLAUDE.md + container.json per folder,
agent_groups rows, four-digit pairing codes via the wire-to flow,
a per-student Drive folder (if GWS layer installed), and writes
`class-roster.csv`.

**The KB and wiki paths must be in the mount allowlist** or the
host will refuse to spawn containers:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

The first run also writes `data/class-shared-students.md` — a class-
wide stance file (default: Socratic-tutor + per-user web-hosting
instructions). Edit it once, every student picks up the change on
their next session.

**Verify:**

```bash
ls groups/
# Should show student_01 ... student_16, ta_01 ta_02, instructor_01
pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder, role FROM agent_groups WHERE folder LIKE 'student_%' OR folder LIKE 'ta_%' OR folder LIKE 'instructor_%'"
```

### 7. Mint and distribute student login URLs

The URL students bookmark = their identity. No Google OAuth required
in shared-classroom mode.

**Mint URLs for everyone on the roster:**

```bash
for email in $(cut -d, -f1 /srv/class-roster.csv | tail -n +2); do
  ncl class-tokens issue --email "$email"
done
```

Each command prints `{ ok: true, email: ..., url: "http://<host>:3002/?token=..." }`.

**Distribute the URLs** via whatever channel you'd normally use to
contact students individually — Canvas, class email, Slack DM,
printed handout. Treat each URL like a password: anyone who has it
logs in as that student.

**A student lost their URL — manual recovery:**

```bash
ncl class-tokens rotate --email alice@example.com
```

Revokes prior tokens, mints a fresh one. The old URL stops working
immediately. Send the new URL via your usual channel.

**A student lost their URL — self-serve recovery (optional):**

If you've configured Resend (see `/add-classroom` step 5c — three
`RESEND_*` env vars), the `/login` page has a "Lost your link?"
form. Students enter their email, the server rotates their token,
and the fresh URL goes to their inbox automatically. Anti-enumeration:
the form shows the same generic success message regardless of
whether the email is on the roster — no info leaks about which
students are enrolled. Without Resend configured, the form falls
back to a "contact your instructor" message.

### 8. Student onboarding

Send each student:

1. Their login URL (from step 7).
2. The Telegram bot username + their pairing code (printed during
   step 6 in the per-student greeting).
3. Brief instructions: "Bookmark the URL to log into the class
   homepage. Open Telegram, message `<pairing-code> <your-email>`
   to the bot to wire your DM identity to your agent."

Their first DM to the bot triggers the pair-consumer chain:

- Role detected from the folder prefix (`student_NN/`)
- Student `agent_group_members` row added
- Drive folder URL DM'd (if GWS layer installed)
- Friendly greeting referencing `/playground`

## Verification — did it work?

The shared-classroom MVP success criteria, runnable as live tests:

- [ ] **Instructor `/setup` ended cleanly** — no manual file edits,
      service active, base agent responsive to DMs.
- [ ] **A test student can log into the homepage** via their
      bookmarked `?token=...` URL (no Google OAuth required) and
      see the embedded playground.
- [ ] **A student-triggered LLM call works** — the request hits the
      class API credit pool (or instructor ChatGPT OAuth as fallback,
      or the local LLM if configured). Check `logs/nanoclaw.log`
      for "Class Codex auth.json written" + spawn logs showing
      `source: class-pool`.
- [ ] **A student can create a Google Doc through their agent** and
      it lands in their shared Drive folder with `nanoclaw_owners`
      set to the student's user_id. Anyone-with-link sharing means
      the instructor and any classmates with the link can read it.
- [ ] **A second student cannot delete or overwrite the first
      student's Doc through their agent** — the relay returns the
      ownership hard-block error naming the creator.
- [ ] **Sheets read/write and Slides create/append/replace-text
      work end-to-end** — same ownership gate applies (Sheets and
      Slides are Drive files; same `nanoclaw_owners` mechanism).

## Day-to-day operations

**Edit the class-wide stance file.** Once, central:

```bash
$EDITOR data/class-shared-students.md
```

Every student's next session picks it up via the symlink.

**Edit per-student persona.** Each student has `groups/student_NN/CLAUDE.local.md`
— students can edit this themselves via `/playground` (locked to
persona-only edits). TAs and instructors can edit non-persona
files on student drafts.

**Rotate the LLM pool key** (e.g., new semester, suspected leak):

```bash
sed -i 's/^CLASS_OPENAI_API_KEY=.*/CLASS_OPENAI_API_KEY=sk-proj-new.../' .env
systemctl --user restart nanoclaw
```

No container rebuild — every new spawn picks up the new key on its
next request to the credential proxy.

**Rotate the playground URL** (e.g., host moved to a new IP):

```bash
sed -i 's|^PUBLIC_PLAYGROUND_URL=.*|PUBLIC_PLAYGROUND_URL=http://new-host:3002|' .env
systemctl --user restart nanoclaw
# Re-mint URLs:
for email in $(ncl users list --field email); do
  ncl class-tokens rotate --email "$email"
done
```

**Add a student mid-semester:**

```bash
pnpm exec tsx scripts/class-skeleton.ts --names "Quinn" --count 1
# Then mint and distribute Quinn's URL + pairing code.
```

The script is additive — existing students aren't touched.

**Next semester:**

Either wipe and re-provision (drop the DB rows) or just re-run
`class-skeleton.ts` with the new names. The token rotation loop
deactivates old students; new students get fresh URLs.

## Troubleshooting

**Container can't reach the GWS relay on port 3007.** Linux + ufw
active without a docker0 allow rule. Add it:

```bash
sudo ufw allow in on docker0 to any port 3007 proto tcp
```

Port 3001 (credential proxy) usually has an iptables ACCEPT from
earlier setup; 3007 has to be added explicitly. Not blocking for
the LLM path (codex apikey mode doesn't use the relay) but blocks
all GWS MCP tool calls from inside containers.

**Codex says it's not authenticated, or 401s on `/v1/responses`.**
Check `~/.codex/auth.json`'s `auth_mode` — should be either
`"apikey"` (with `OPENAI_API_KEY` populated) or `"chatgpt"` (with
`tokens` populated). **Note no underscore in `"apikey"`** — codex's
format differs from Python conventions; `"api_key"` returns 401.
Don't hand-edit; use `printenv OPENAI_API_KEY | codex login --with-api-key`.

**`/model` Telegram command lists Claude models for a codex group.**
Pre-`9074e0c` drift between `agent_groups.agent_provider` and
`container.json`. Fix:

```bash
ncl groups update <group_id> --provider codex
```

**Playground login URL goes to `http://localhost:3002`** — student
sees an unreachable URL. `PUBLIC_PLAYGROUND_URL` was left at the
default. Edit `.env`, restart, re-mint URLs (see "Rotate the
playground URL" above).

**OAuth URL from `gws-authorize.ts` got line-wrapped and won't
paste cleanly.** The script writes the URL to a tmp file (mode
0600) and prints the path. Use the file path instead of the
inline URL.

**Student's agent stops responding mid-class.** Container heartbeat
likely stale. Check `data/v2-sessions/<group>/<session>/` for
`.heartbeat` mtime + `outbound.db` for pending messages. The host
sweep (60s) should recover automatically; if not, `systemctl --user
restart nanoclaw`. Persistent issue means a problem in container
spawn — check `logs/nanoclaw.error.log`.

## Looking ahead — per-person classroom

The shared-classroom mode in this guide is intentionally simple:
one instructor authorizes Google + the LLM pool, students consume
from there with NanoClaw-side friction preventing cross-student
write damage. It's enough for most teaching scenarios — Socratic
tutors, RAG labs, multi-week projects with shared deliverables.

The per-person classroom mode (master plan Phase 2) layers:

- **Per-student Google OAuth** — each student authorizes against
  their own Drive; the agent operates as them; Google's own auth
  enforces what they can access (real privacy boundary, not the
  NanoClaw-side friction primitive).
- **Per-student LLM provider OAuth** — students authorize their
  own ChatGPT/Anthropic/OpenAI account; the instructor's pool
  becomes a fallback (or expires after a temp code window).
- **Provider settings UI** on the homepage so students manage
  their own auth flows.
- **Agent export tooling** so an instructor can hand a student
  their custom agent in `nanoclaw`/`claude-code`/`codex`/`json`
  format at the end of the class.
- **Walk-away cloud deploy** so the class instance can be bundled
  and re-deployed on a fresh VPS with one bootstrap script.

None of those are blocking for a first deploy. Ship shared mode
first, learn what your class actually needs, then layer.

## Related docs

- [docs/architecture.md](architecture.md) — how the host + container split works
- [docs/isolation-model.md](isolation-model.md) — channel-level isolation (separate from classroom role-tier isolation)
- [docs/local-llm.md](local-llm.md) — running the class on a local LLM server instead of OpenAI API
- [docs/db-central.md](db-central.md) — the tables under `data/v2.db`
- [plans/master.md](../plans/master.md) — full delivery plan (internal artifact)
