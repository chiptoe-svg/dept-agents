# Department Agent Server — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorm complete; awaiting implementation plan)

## Goal

Transform this install into an easy-to-use agent server for ~15 department
faculty/staff. Each person gets their own isolated agent (own memory, base
persona + skill set, ability to add their own skills) reachable via a web
homepage and optionally Telegram. Onboarding is a single email link: click →
working agent → connect ChatGPT for their own usage. Provider-neutral by
design (Codex/ChatGPT required now, Claude a likely later option), given
possible future enterprise alignment.

**Timeline/success bar:** pilot with 2–3 friendly colleagues soon; iterate
before opening to all ~15.

## Decisions (with rationale)

| Decision | Choice | Rationale |
|---|---|---|
| Fork base | **This repo (gccourse fork), transformed in place** | Everything hard is live-verified here: pi runner (anthropic + openai-codex), playground web UI, magic-link + PIN auth, per-user provider OAuth registry, class-pool fallback, Resend email. Stripping is cheaper than porting. |
| Classroom preservation | **Freeze branch + data snapshot; classroom revived on a new box in August** | Git preserves code, not runtime state — so `classroom-freeze` branch + tag AND an archive of `data/`, `groups/`, `.env`. `/install-handoff` skill does the August move. |
| Backend | **Keep the pi harness; do not re-base onto upstream now** | Pi is a thin adapter over the external `pi-ai` project; owned surface is small and battle-tested. Upstream convergence deferred — `migrate-nanoclaw` (intent-based migration) keeps it reversible when enterprise requirements are concrete. |
| Usage split | **User's ChatGPT for user-initiated functions; dept OpenAI API key for everything else and as backstop (with warning)** | Matches faculty expectations: their subscription covers their use; dept absorbs system overhead and outages. |
| Onboarding | **Admin-provisioned invites; Clemson email = canonical identity** | 15 known people; no self-registration surface. |
| Secrets | **`.env` + built-in credential proxy; defer OneCLI** | Native proxy already runs pi end-to-end on this box (OAuth landmines fixed). OneCLI adds a process the pilot doesn't need; revisit at enterprise stage. |
| Web UI | **Evolve the playground "My Agent" surface** | Chat card, rollups, skills UI, per-seat config already built. Persona/skills tucked under collapsed rollups to avoid overwhelming users. |

## §1 Repo strategy & deployment topology

1. `git branch classroom-freeze` + tag `classroom-2026-07` at current HEAD,
   pushed to origin. August revival point.
2. Archive runtime state to a dated snapshot outside the repo
   (`~/archives/classroom-2026-07.tar.gz`): `data/`, `groups/`, copy of
   `.env`. August: clone at `classroom-freeze` + restore snapshot on the new
   box (use `/install-handoff`).
3. `main` in this folder becomes the department server, inheriting the live
   wiring: port 3002, Caddy proxy (`130.127.162.180:8088` /
   `gcworkflow.clemson.edu`), launchd service `com.nanoclaw-v2-581fefa4`,
   Apple Container runtime, built agent image.
4. Department server boots with **fresh `data/v2.db` and fresh `groups/`** —
   no classroom users/wiring carried over.
5. The personal install (`~/projects/nanoclaw_personal`) is untouched and
   coexists.
6. **Consequence:** the classroom pilot is down from switchover until August.
   Intended (back-burner).
7. Rename the GitHub repo from `nanoclaw_gccourse` to a department-neutral
   name (owner's pick, e.g. `nanoclaw-dept`); GitHub redirects the old URL.

## §2 Invite → login → working agent

1. **Admin provisions** (via `ncl` or admin UI): name + Clemson email →
   creates user record, personal agent group (fresh workspace/memory, base
   persona + skills), web-UI wiring, single-use invite token.
2. **Invite email** (Resend) with one magic link to their homepage.
3. **First click authenticates:** magic link → session cookie, hardened with
   the email-PIN pattern (6-digit PIN to their Clemson email on a new
   browser). URL stays bookmarkable; new device re-triggers PIN.
4. **Agent works immediately, before ChatGPT login** — first turns run on the
   dept OpenAI key (class-pool fallback pattern) with a visible banner
   prompting ChatGPT connection.
5. **Connect ChatGPT** via paste-back OAuth (provider-registry pattern +
   per-group codex auth from the personal repo). After connect: user turns on
   their subscription; dept key keeps covering system functions and steps
   back in as backstop (with user-visible warning) on missing/expired token
   or exhausted credits.

Key property: zero-friction success on the first click. ChatGPT connection is
an upgrade step, not a gate.

## §3 Per-user isolation & agent model

- **One agent group per person:** own `groups/<name>/` (workspace, memory,
  persona), per-session containers (Apple Container), own session DBs. No
  shared runtime state between users.
- **Persona = department base (version-controlled in repo) + per-user overlay**
  (edited from homepage rollup), composed at session start via the existing
  persona-composition seam + `agents-compose` size guard (ported). Base
  updates propagate without clobbering user customizations.
- **Skills = base set (`container/skills/`) + per-group additions +
  self-built.** Port `hermes-selflearning` + `self-customize` from the
  personal repo; self-built skills confined to the user's group folder,
  listed in the homepage skills rollup with enable/disable + source viewer.
- **Memory:** per-group persistent memory (personal-agent model). No
  cross-user memory.
- **Privilege:** users are unprivileged members of their own agent group;
  owner/global admin is the operator. Container-changing actions
  (`install_packages`, `add_mcp_server`) route through the existing approval
  flow to the admin.
- **Channels:** Telegram linking wires a second messaging group to the same
  agent group — same agent, same memory, both surfaces.
- **Provider per group:** existing `model_provider` column routes pi to
  anthropic or openai-codex per group — the Claude-later story requires no
  code change.

## §4 Credentials

`.env` + built-in credential proxy (real secrets host-side only; containers
see placeholders; proxy at the bridge gateway substitutes at request time).

1. **Dept OpenAI API key** — `.env`. System functions + backstop. Rotation:
   edit `.env`, restart service.
2. **Per-user ChatGPT OAuth tokens** — captured by homepage paste-back,
   persisted per agent group on the host (`pi-auth` group persistence),
   auto-refreshed. Never in container env, chat context, or git.
3. **Infra keys** (Resend, Telegram bot, later Anthropic) — `.env`.

**Backstop routing:** per request, pi selects the user token for
user-initiated turns, dept key otherwise. Fallback events surface in the
homepage usage card + inline banner, and in the admin roster so dept-key
spend is visible.

## §5 Homepage

Evolved playground "My Agent" surface, re-skinned, per seat.

**Default view:** chat with the agent (centerpiece) + one slim status strip
(ChatGPT connection state, usage, connect CTA / backstop banner).

**Collapsed rollups:** Persona & instructions (overlay editor,
unsaved-changes indicator) · Skills (base toggles, own + self-built list,
source viewer) · Channels (Telegram linking) · Activity trace (collapsed by
default).

Responsive web — phone-usable from the invite link; Telegram covers
mobile-native.

**Admin view (role-gated, same app):** roster — invite (name+email),
per-user status (invited / active / ChatGPT-connected / riding backstop),
resend invite, disable seat; dept-key usage overview.

## §6 Strip / Port / New work

**Strip from `main`** (recoverable from `classroom-freeze`):
- Classroom role system (instructor/TA/student tiers, folder-prefix roles).
- Classroom skills + wiring: `add-classroom`, `add-classroom-gws`,
  `add-classroom-pin` *as a class feature* (PIN mechanism survives, rewired
  to per-user invites), deprecated `add-classroom-auth`, classroom wiki
  wiring.
- Seminar config: class tokens, seminar seats in `playground-seats.json`,
  seminar branding.
- Class-specific dev skills under `.claude/skills/`; general-purpose stay.

**Port from `~/projects/nanoclaw_personal`:**
- `hermes-selflearning`, `self-customize`.
- `agents-compose` persona size guard; SSRF-safe `fetch_url_to_workspace`;
  Apple Container 1.0.0 orphan-cleanup fix (if absent here).
- **Pi harness reconciliation:** diff both repos' pi trees; merge
  best-of-both (personal: per-group ChatGPT auth refinements; here:
  seq-bound usage backfill).

**New work:**
- Invite flow (provision → Resend email → magic-link seat, PIN rewire).
- Backstop warning events + usage surfacing (user card + admin roster).
- Homepage reorganization per §5.
- Telegram self-serve linking flow.
- Admin roster view.
- Department base persona + curated base skill set.
- Fresh-DB bootstrap path.

## Pilot success criteria

1. Operator invites 2–3 colleagues by email.
2. Each clicks the link and is chatting within a minute on the dept backstop.
3. Each connects ChatGPT; their turns bill to their own subscription.
4. A persona edit and a self-built skill persist across sessions.
5. One pilot user links Telegram and reaches the same agent.
6. No user can access another's agent, memory, or files.
7. Classroom freeze (branch + snapshot) verified restorable.

## Out of scope (explicitly deferred)

- OneCLI / centralized secret management — revisit at enterprise stage.
- Upstream nanoclaw convergence — deliberate later phase via
  `migrate-nanoclaw` when enterprise requirements are concrete.
- Classroom revival — August, on a different box.
- Channels beyond web + Telegram at launch.
- Self-registration of any kind.
