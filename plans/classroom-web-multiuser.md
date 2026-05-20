# Classroom Web Access — multi-user playground, Google login, student home page

## Goal

Make the classroom feature work for a real 25-student course where every
student gets:

- **Web-only access** — no laptop install, no Telegram required. Just a
  URL, a Google sign-in, and a browser tab.
- **A home page** that's the primary surface — playground, settings
  (including optional Telegram link), agent export, and a small
  dashboard. Telegram becomes optional, not the front door.
- **Concurrent playground sessions** — students iterate on persona,
  skills, traces, models, etc. at the same time without kicking each
  other out.
- **Their own Google Workspace** — Doc/Sheet/Drive operations run as
  the student, not the instructor. Boundary enforced by Google, not by
  URL parsing.
- **Agent portability** — export the tweaked agent (persona + skills
  + container config) into formats they can reuse outside class
  (Claude Code project, Codex prompt, generic JSON).
- **Local-LLM ready** — the same setup plays nicely with a locally
  hosted model behind an OpenAI-compatible endpoint (mlx, Ollama,
  LM Studio). Wiring goes through the existing Codex provider path,
  not a new provider.
- **Expert-system / RAG-alternatives lab** — students build
  knowledge sources from class materials and try multiple ingest
  strategies (filesystem, agentic, vector, sparse, hybrid,
  long-context, hierarchical, graph), then run query sets to
  *measure* which strategy works best for their queries.
  Pedagogical core: there's no single right answer; the point is
  to surface tradeoffs.

Today's gap (verified against `src/channels/playground.ts` and the
`add-classroom*` skills):

- Playground HTTP auth uses a **module-level singleton cookie** —
  whoever sent `/playground` last is the only authed user. Fine for
  one operator iterating; broken for 25 concurrent students. The
  classroom-side role gates are already multi-user-aware (they take
  `userId`); the auth front-end was never rebuilt to match.
- Playground access today **requires a Telegram round-trip** to get a
  magic link. Students-without-Telegram is a real constraint for many
  courses.
- All GWS calls today route through the **instructor's OAuth bearer**
  (gws-mcp planned Phase 13/14 — Phase 14 is the per-student fix).

## Architectural shape

Eight pieces, sequenced so each lands independently and is testable:

```
1. Multi-user session store        ─► fixes "kicked-out" today
2. Google OAuth + roster + home    ─► fixes "needs Telegram" today;
   page (minimal: login + landing)    establishes the home-page surface
3. Per-student GWS refresh token   ─► fixes "instructor's bearer" today
   (= gws-mcp Phase 14, folded in)
4. Home page expansion             ─► settings, export-tools, dashboard,
                                       picker-role-filter
5. Agent export tooling            ─► persona + skills + container.json
                                       → Claude/Codex/JSON formats
6. Local-LLM via codex provider    ─► OPENAI_BASE_URL → mlx-omni-server
                                       (or Ollama/LM Studio)
7. Expert system builder tab       ─► per-draft knowledge sources;
                                       multiple ingest strategies
                                       (text, multimodal PDF, video,
                                       long-doc tree, graph, …) —
                                       SCOPE OPEN, see "RAG phase"
                                       discussion below
8. Evaluation framework            ─► run query sets across strategies,
                                       score, compare side-by-side
9. Walk-away cloud deploy          ─► export the student's full state
                                       (agent + knowledge + experiments)
                                       into a bootstrap-able NanoClaw
                                       instance on their own VPS
```

Pieces 2 and 3 share the same OAuth dance — one Google consent screen,
two outcomes. So we wire them together rather than building Phase 14
as a separate effort.

Pieces 4–6 each stand alone and can be deferred without blocking a
working class deployment. Phase 2 ships a *minimal* home page (login
screen + "Open Playground" button); Phase 4 turns it into a real
dashboard.

Pieces 7 + 8 are the "lab payload" — what students *do* in class once
the infrastructure (1–6) is in place. Phase 7 builds the pipeline
framework + named strategies; Phase 8 makes them measurable. They're
independent of each other ordering-wise but only useful together.

## Skill packaging (each phase ships into the right skill)

Per the project's skill-extraction philosophy — additive, layered,
each skill scoped to one concern:

| Phase | Skill |
|-------|-------|
| 1 | trunk fix on `/add-agent-playground` (the single-cookie bug was never a feature) |
| 2 + 3 + 4 | `/add-classroom` (expanded) — roster, Google OAuth, home page are core class infra |
| 5 | `/add-agent-export` (new, generic) — useful outside class for anyone wanting a portable agent |
| 6 | docs + `.env` runbook in `/add-classroom`'s SKILL.md (no code to install) |
| 7 + 8 | `/add-classroom-rag` (new, layered onto classroom) — not every class wants the RAG lab; this is the "expert assistant" workbench, distinct from the base class feature |
| 9 | `/add-walkaway` (new, generic) — per-student bundle export → bootstrap → run; useful for any single-student install, not just classroom |

## Phase 1 — Multi-user session store

> **Status: ✅ shipped** on `origin/feat/playground-multiuser` (gccourse).
> 7 unit tests + 12-assertion in-process HTTP smoke green. Live
> two-browser verification still pending real-host run. See
> `plans/upstream-pr-prep.md` §3 for the per-tick smoke matrix.

**File:** `src/channels/playground.ts` (rework auth section, ~50 LoC
changed)

**The fix is mechanical**, not architectural:

```ts
// Today (lines 60-69):
let magicToken: string | null = null;
let cookieValue: string | null = null;
let cookieUserId: string | null = null;
let lastActivityAt = 0;

// Rework:
interface PlaygroundSession {
  userId: string | null;       // Telegram or Google identity
  expiresAt: number;            // ms since epoch
  lastActivityAt: number;
}
const sessions = new Map<string /*cookieValue*/, PlaygroundSession>();
const pendingMagicTokens = new Map<string /*token*/, { userId: string | null; expiresAt: number }>();
```

**Behavior changes:**

- `/playground` from Telegram mints a fresh token, adds it to
  `pendingMagicTokens` (5-min TTL), prints URL. Doesn't invalidate
  anyone else's session.
- `/auth?key=<token>` consumes the token, mints a new
  `cookieValue`, inserts a `PlaygroundSession`, sets the cookie.
- `checkAuth(req)` looks up the cookie in `sessions`, validates not
  expired, bumps `lastActivityAt`. Returns the `userId` so handlers
  can pass it into `checkDraftMutation({ userId, ... })`.
- Idle sweep runs on a 1-minute interval — drops sessions past
  `PLAYGROUND_IDLE_MS`, closes their SSE clients.
- `/playground stop` removes ALL sessions (current behavior preserved
  for instructors who want to nuke everyone).
- New: `/playground stop --self` removes only the caller's session.

**SSE tracking** already keys by `draftFolder`; no change needed.
The `cookieUserId` plumbed through `checkDraftMutation` becomes a
per-request lookup from the session map.

**Tests:**

- `playground.test.ts` (new) — two-session round-trip: A authes, B
  authes, both can call API without kicking the other; idle expiry
  drops only the idle session; `/playground stop --self` only removes
  caller.
- Doesn't need a real HTTP server — refactor the auth helpers to be
  testable independently of `http.createServer`.

**Done when:** two browsers, two cookies, both work simultaneously.

---

## Phase 2 — Google OAuth login + roster + minimal home page

> **Status: ✅ shipped (slice A)** on `origin/feat/playground-google-oauth`
> (gccourse), stacked on Phase 1. Slice A = `classroom_roster` table +
> `google-oauth.ts` handlers + `login.html` + `home.html` + `/playground/`
> route move + `/api/home/me`. **Slice B deferred** to a follow-up against
> `origin/classroom`: the `--roster <csv>` flag in `class-skeleton.ts`.
> 13 unit tests + 18-assertion in-process HTTP smoke green. Live
> in-browser verification gated on the GCP redirect-URI registration —
> see `project_gcp_oauth_pending` memory.

Lets students access the playground without Telegram, and establishes
the home-page surface that later phases expand.

> **Reuses existing classroom role plumbing — no new permission tables.**
> `/add-classroom` already wires the four-tier structure (admin =
> instance owner; instructor = global `admin` role; TA = `admin`
> scoped to every student/TA agent group; student = `member` of own
> group only). Mechanism is `user_roles` rows granted at pair-time by
> `class-pair-instructor.ts`, `class-pair-ta.ts`, and the student
> greeting consumer. Folder prefixes (`student_NN/`, `ta_NN/`,
> `instructor_NN/`) are canonical for role detection. The Phase 2
> roster table is just `email → user_id` mapping, where `user_id`
> resolves to the same `class:student_NN` IDs the existing pair
> consumers produce. The role grants happen exactly as before;
> Google login swaps out the discovery channel (was Telegram pair
> → now web magic-link OR Google OAuth) but the resulting role
> assignment code path is unchanged.

**Why Google over email-magic-link:**

- Zero account creation. Students already have school/personal
  Google accounts.
- Email assertion comes from Google, not from the student typing
  their address — no email-spoofing surface.
- Reuses GWS OAuth client (already in
  `~/.config/gws/credentials.json` for installs that have done
  `/add-classroom-gws`). Same client, just adds redirect URIs.
- **Same OAuth refresh token feeds Phase 3** — see below.

**New files:**

- `src/db/migrations/016-classroom-roster.ts` — adds `classroom_roster`
  table:
  ```
  email          TEXT PRIMARY KEY      -- normalized lowercase
  user_id        TEXT NOT NULL         -- e.g. 'class:student_03'
  agent_group_id TEXT                  -- their personal agent group
  added_at       INTEGER NOT NULL
  ```
- `src/db/classroom-roster.ts` — CRUD for above. `lookupByEmail`,
  `addEntry`, `removeEntry`, `listAll`.
- `src/channels/playground/google-oauth.ts` — OAuth handlers.
  `/oauth/google/start` redirects to consent; `/oauth/google/callback`
  exchanges code for tokens, looks up email in roster, mints
  playground session if matched. Reuses `src/gws-auth.ts` for the
  token exchange (already exists).
- `src/channels/playground/login.html` — minimal landing page:
  "Sign in with Google" button + a separate "Have a magic link?"
  link for instructors with Telegram access.
- `src/channels/playground/home.html` (+ `home.js`, `home.css`) —
  minimal post-login landing. Greeting ("Hi Alice"), an "Open
  Playground" button that links to the existing playground UI at
  `/playground/`, and placeholder slots for the Phase 4 settings /
  export / dashboard panels. Routing change: today's `index.html`
  moves to `/playground/index.html`; `/` becomes the home page.

**`/add-classroom` integration:**

- Skeleton script learns a `--roster <file>` flag. The file is a CSV
  with `email,user_id` rows; `class-skeleton.ts` writes those rows
  into the new table during provisioning.
- Re-running `/add-classroom` with the same roster is idempotent
  (UPSERT on email).

**Telegram magic-link path stays.** Instructors and TAs paired via
Telegram still use `/playground`; the Google route is just the
no-Telegram path. Same session store, just two ways to mint a session.

**Done when:** student visits `https://class.example.com/`, clicks
"Sign in with Google," picks their school account, lands in the
playground scoped to their `student_NN` draft. Their email isn't
in the roster → "you're not enrolled in this class" page.

---

## Phase 3 — Per-student GWS refresh token (= gws-mcp Phase 14)

> **Status: ✅ shipped (slice A — write side)** alongside Phase 2 on
> `origin/feat/playground-google-oauth`. The OAuth callback persists the
> per-student refresh token to
> `data/student-google-auth/<sanitized_user_id>/credentials.json`,
> preserving the on-disk token if Google omits one on re-consent.
> **Slice B deferred** to `origin/classroom`: the credential-proxy
> per-request *read-side* lookup that swaps the instructor's bearer for
> the per-student token. Until B lands, agents still call Google with
> the instructor's OAuth — the per-student credentials sit on disk
> waiting for the proxy to consult them.

This is the per-student-OAuth piece from `plans/gws-mcp.md` Phase 14,
folded into this plan because it's the same OAuth dance as Phase 2.

**Mechanics:**

- The Google consent screen Phase 2 sends students through requests
  scopes: `openid email` (for identity) + the full GWS scopes the
  course needs (`drive.file`, `documents`, etc.).
- The callback in `google-oauth.ts` already has the refresh token in
  hand from the code exchange. Phase 2 throws it away after pulling
  the email; Phase 3 keeps it.
- Per-student creds path:
  `data/student-google-auth/<sanitized_user_id>/credentials.json`.
  Same shape as `~/.config/gws/credentials.json`, same loader logic
  via `src/gws-auth.ts`.
- `src/credential-proxy.ts` (or the new `src/gws-mcp-relay.ts` from
  the gws-mcp plan) does a per-request lookup keyed on the calling
  agent group's `student_user_id` metadata. Falls back to instructor
  creds if no per-student auth uploaded yet — graceful migration.
- `class-shared-students.md` instructions point students at the
  Google sign-in URL (which now does double duty — playground access
  AND GWS authorization).

**Why this is "free" given Phase 2:**

- The OAuth client is already configured (one-time GCP Console
  redirect-URI add).
- The token exchange already happens in `google-oauth.ts`.
- The only Phase-3-specific work is *persisting* the refresh token
  per-student instead of throwing it away, plus the proxy lookup.

**Done when:** student's agent calls
`drive_doc_read_as_markdown(fileId)` — the call uses *that student's*
refresh token. Reading another student's Doc returns 403 from
*Google*, not from a URL parser.

---

---

## Phase 4 — Home page expansion (settings, dashboard, picker filter)

Phase 2 shipped the home page as a stub. Phase 4 turns it into the
primary surface for the course.

**Routing layout** (after Phase 2 is in place):

```
/                          home page (this phase fills it out)
/login                     Google OAuth + magic-link entry
/oauth/google/callback     OAuth callback
/playground/               existing playground UI (unchanged surface)
/api/...                   existing playground REST + SSE endpoints
/api/home/...              new endpoints for the home-page panels
```

**Panels to add (each is one tab/card on the home page):**

1. **Settings**
   - **Telegram link** — "Connect Telegram" button. Generates a
     pairing token; student `/start`s the bot in Telegram with that
     token; bot replies "linked." After link, agent-side
     notifications (long-running result, request_reauth, etc.) DM
     them in addition to the home-page surface. Without link they
     just see updates in the home-page log/dashboard.
   - **Display name + email** (read-only, from roster).
   - **Per-agent provider + auth** — see "Provider settings" below.
   - **Idle / re-auth controls** — "log out everywhere" button =
     `revokeSessionsForUser(self)`.
2. **Dashboard**
   - Last 24h: messages exchanged, tokens used (from outbound.db
     once it tracks token counts — currently doesn't, so initial
     dashboard shows messages-only and a "tokens coming soon"
     placeholder), errors.
   - Container status: running / idle, last-activity timestamp.
   - Per-channel breakdown if multiple channels are wired (web,
     Telegram).
   - Optionally: GWS quota / Drive folder size if Phase 3 is in.
3. **Export** — see Phase 5; Phase 4 just provides the UI panel that
   calls Phase 5's export endpoints.
4. **Picker-role-filter** — small but real follow-up from
   `agent-playground-v2.md`. The playground picker currently lists
   *every* non-draft agent group; for students, filter to only their
   own. Phase 4 routes the playground link into the home page so the
   filter applies cleanly: `/playground/?onlyMine=1` for student
   sessions; instructors get the full list.

**Provider settings (the per-agent provider + auth panel):**

For each of the student's drafts (in practice usually one), a card
shows:

- **Provider dropdown** — Claude Code | OpenAI Codex | Local LLM |
  Custom OpenAI-compatible. Selection writes to
  `agent_groups.agent_provider` (existing column; same column the
  playground topbar toggles); the next message respawns the
  container with the new provider.
- **Credential status** — one of:
  - `Using class default` (instructor's bearer; what the install
    has today before any per-student auth)
  - `Connected: Anthropic API key (••••wxyz)` / `Connected:
    Anthropic OAuth (subscription, refreshes auto)` /
    `Connected: ChatGPT subscription via /add-classroom-auth`
  - `Connection expired — re-authenticate`
- **Connect / re-authenticate button** per provider:
  - **Anthropic** — paste API key OR magic-link OAuth (the
    OAuth-token-capture flow used in `setup/lib/cli-assist.ts`'s
    `runClaudeSetupToken` is reusable here).
  - **OpenAI Codex** — magic-link upload of `auth.json`. Reuses
    the entire `/add-classroom-auth` flow that already exists; the
    home page just hosts the entry-point button instead of a
    Telegram `/login` command.
  - **Local LLM** — picks from a dropdown of instructor-configured
    endpoints (an opinionated set the instructor curated, e.g.
    "Class Mac Studio: Qwen 2.5 32B"). No auth needed — the
    network is the boundary.
  - **Custom OpenAI-compatible** — paste base URL + key. For
    students who set up their own LM Studio at home or pay for an
    OpenRouter sub. Validated by issuing a tiny test request.

**Per-student creds storage** mirrors the existing
`/add-classroom-auth` and Phase 3 GWS pattern:

```
data/student-creds/<sanitized_user_id>/
  anthropic.json       { type: 'api-key' | 'oauth', key|token, expiresAt? }
  openai.json          { type: 'auth.json', uploadedAt }     ← /add-classroom-auth already does this
  custom.json          { baseUrl, key }
```

**⚠️ Correction (2026-05-10):** an earlier draft of this plan said
*"the credential proxy already supports per-request lookup keyed on
the calling agent group (Phase 9 of `/add-classroom-auth`)."* This was
wrong. Verified by grepping `origin/classroom`'s `src/credential-proxy.ts`
during slice B work: no per-call agent-group attribution exists. The
codex per-student auth pattern (`src/class-codex-auth.ts`) works via
`auth.json` files mounted at container-spawn time — never goes through
the proxy at request time.

So the per-student-credentials wiring this section needs is genuine
new infrastructure, not a "free" extension. It's been promoted to its
own plan: see `plans/credential-proxy-per-call-attribution.md` for the
attribution mechanism choice (header / port / source-IP) and the
proxy-side lookup design. Phase 4 + Phase 3 slice B both depend on it.

What Phase 4 (and Phase 3 slice B) actually need to do, post-attribution:
extend the proxy's per-credential resolution chain to consult these
per-student paths first, falling back to the instructor's bearer if no
per-student cred exists for the chosen provider.

**Default-provider determination on draft creation:**

When a student forks a draft from the target group, the draft
inherits the target's `agent_provider`. Student can change it
immediately via this settings panel. If they have no creds for the
new provider, the fallback path is explicit and visible: "Using
class default" badge on the dropdown.

**Cost-attribution implication:**

Per-student creds means *the student* pays (their subscription /
their key). Class-default means *the instructor* pays. Phase 8's
cost-tracking framework needs to attribute correctly: when an
experiment runs against an agent using per-student auth, the
recorded cost is informational; against class default, the
instructor's running tally goes up. UI should make this visible
("you paid $0.04 for this experiment" vs. "class paid $0.04").

**Skill-extraction implication:**

Anthropic per-student auth doesn't exist yet — `/add-classroom-auth`
covers Codex only. Two options:

(a) Extend `/add-classroom-auth` to handle both. Skill becomes
    multi-provider; student's "auth" is a generic per-provider
    table. Cleaner long-term; bigger one-time refactor.
(b) Add `/add-classroom-anthropic-auth` as a sibling skill,
    parallel structure to the existing one. Simpler now; possibly
    rename later when a third provider arrives.

I'd lean (a). The existing `/add-classroom-auth` is small enough
that generalizing it is cheaper than maintaining two parallel
skills, and the "per-student auth for provider X" pattern is going
to recur (custom-LLM endpoints are the third instance already).
**Marking this as a Decision-10 open item — needs your input.**

**Files (added to Phase 4):**

- `src/channels/playground/home/provider-settings-pane.{html,js}` — UI.
- `src/channels/playground/api-providers.ts` — `/api/home/providers/{status,connect,disconnect}`.
- `src/credential-proxy.ts` — extend the per-student lookup that
  Phase 3 added (GWS) to also consult `data/student-creds/<user>/`
  for the agent's chosen provider before falling back to instructor.
- Per Decision 10 (a): refactor `/add-classroom-auth` (in the
  classroom branch) into multi-provider shape; per (b): new
  `/add-classroom-anthropic-auth` skill mirroring the existing one.

**Files:**

- `src/channels/playground/home/{home.html,home.js,home.css}` —
  three-pane layout, vanilla JS (matches playground UI choices).
- `src/channels/playground/api-home.ts` — `/api/home/dashboard`,
  `/api/home/telegram-link/start`, `/api/home/telegram-link/confirm`,
  `/api/home/sessions/revoke-all`.
- `src/channels/telegram.ts` — `/start <pairing-token>` consumes the
  token, links `telegram:<id>` ↔ `class:<student>`.

**Done when:**

- A logged-in student lands on `/`, sees their dashboard, can link
  Telegram from settings, can click into the playground and only
  see their own draft.
- A logged-in instructor lands on `/`, sees a class-wide dashboard,
  can click into the playground and see all student drafts.

**Hours est:** ~9–12 hr. UI plumbing is most of it; the per-student
provider-auth piece adds the Anthropic OAuth flow + the
credential-proxy lookup extension. Decision 10 (skill refactor vs.
new sibling skill) affects ~2 hr of that estimate.

---

## Phase 5 — Agent export tooling

Lets a student or instructor walk away with a portable artifact of
their tweaked agent — for personal use, archival, or porting to a
non-NanoClaw workflow.

**Three export targets, one source of truth:**

The "agent" being exported = the agent-group folder layout NanoClaw
already uses:

```
groups/<folder>/
  CLAUDE.md           ← persona prompt
  CLAUDE.local.md     ← user-editable persona (the playground's
                        primary edit target)
  container.json      ← provider + model + skills + mounts
  skills/             ← per-group skill overlays
```

Three export shapes:

1. **`nanoclaw` (default, lossless)** — tarball or zip of the
   group folder verbatim. Reimport: drop into another NanoClaw
   install's `groups/` directory, run `ncl groups create
   --from-folder <path>`. Round-trips the agent exactly.
2. **`claude-code`** — emit a Claude Code project skeleton:
   `CLAUDE.md` rewritten with the persona content, `.claude/skills/`
   populated from the group's skills overlay. Drops into a fresh
   directory; user runs `claude` from there to use it. Lossy:
   container.json mounts and provider config don't apply outside
   NanoClaw.
3. **`codex`** — emit a Codex-friendly bundle: `AGENTS.md` with the
   persona content, plus a `.codex/skills/` directory if Codex
   honors that path (research before implementing). Lossy in the
   same way as Claude Code export.
4. **`json` (catch-all)** — single JSON file with persona, model,
   provider, skill list, container settings. Useful for "show me
   what my agent looks like" and for any future tooling that wants
   to consume agent specs programmatically.

**API:**

```
GET /api/draft/<folder>/export?format=<nanoclaw|claude-code|codex|json>
```

Returns a `Content-Disposition: attachment` response. The home page's
Export panel renders four "Download as …" buttons.

**Files:**

- `src/agent-export/index.ts` — orchestrator; dispatches by format.
- `src/agent-export/{nanoclaw,claude-code,codex,json}.ts` — one
  formatter per target, ~50–100 LoC each. Pure functions: take the
  group folder path, return a buffer to send.
- `src/channels/playground/home.ts` (Phase 4) — wires the export
  buttons into `GET /api/draft/<folder>/export`.

**Open during Phase 5 — verify the actual format Codex expects.**
The `AGENTS.md` convention is documented in this repo's own
`AGENTS.md`; whether external Codex tooling reads it is the
question. Worst case, drop "codex" target and ship JSON + Claude
Code + nanoclaw.

**Hours est:** ~4–5 hr including format research.

---

## Phase 6 — Local-LLM via Codex provider (mlx / Ollama / LM Studio)

The codex provider in NanoClaw already accepts an
`OPENAI_BASE_URL` override — the credential proxy multiplexes
`/openai/*` to `api.openai.com` by default but can route anywhere. To
serve the class from a local model on the Mac Studio, point that path
at a local OpenAI-compatible server.

**Decision: use the codex provider, not a new "local" provider.**

Reasons:

- The existing path is already audited for header-rewrite
  correctness (`Authorization: Bearer …` injection, key
  substitution).
- Per-agent-group `agent_provider='codex'` already exists in the DB.
- A new provider would mean new container env, new spawn args, new
  proxy routing. Worth avoiding if a config flip can do it.

**What changes — three lines of config + one tiny proxy tweak:**

1. **Run a local OpenAI-compatible server.** mlx-omni-server is
   the natural pick on Apple Silicon (uses MLX under the hood;
   loads GGUF or MLX-native models; exposes `/v1/chat/completions`).
   Ollama works too via its OpenAI-compat layer, with a llama.cpp +
   Metal backend rather than MLX. LM Studio also fine. None of these
   require code changes — they're host-side daemons.
2. **Set `OPENAI_BASE_URL` in `.env`** to the local server, e.g.
   `http://localhost:8080`. The credential proxy reads this on
   startup and uses it as the upstream for `/openai/*` requests.
3. **`OPENAI_API_KEY=local`** (or any string) — local servers
   typically ignore the key. Set something non-empty so SDKs that
   refuse to init without a key still work.
4. **Pick a model** — `OPENAI_MODEL=qwen2.5-coder-32b-instruct`
   (or whatever you've loaded locally). The credential proxy passes
   the model name through unchanged.

**Sizing:**

Out of scope for this plan, but worth noting: 25 students hitting
one local model concurrently will queue. Recommend testing with
batched-inference servers (mlx-omni-server with `--batch` or vLLM if
the model fits) and a smaller model (Qwen 2.5 32B Q4 or 14B for
faster turnaround) before committing the course design to this path.

**Files (almost nothing):**

- `src/credential-proxy.ts` — already supports `OPENAI_BASE_URL`
  override. Verify the request-rewriting handles arbitrary upstream
  hosts (no hardcoded `openai.com` checks). One small audit pass.
- `docs/local-llm.md` (new) — runbook for installing
  mlx-omni-server, configuring `.env`, picking a model.
- `.claude/skills/add-classroom/SKILL.md` — add a note pointing at
  the runbook for instructors who want local-only.

**Hours est:** ~2–3 hr. Mostly the runbook and the proxy audit.
The actual config flip is a handful of `.env` lines.

---

---

## Phase 7 — Expert System Builder tab (knowledge ingest)

> **⚠️ Scope open — RAG-design discussion in progress.** Some decisions
> have been locked (see "Design decisions" sub-section below); others
> are still open and noted explicitly. The earlier draft assumed mostly
> text corpora. Real course content includes video lectures, multimodal
> PDFs (figures, tables, equations), long complex documents with
> cross-references, and corpora that don't fit any single retrieval
> model. Sections below reflect locked decisions; structure-only
> placeholder until the open items resolve.

### Design decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Pipeline framework**, not discrete strategies. Stages: `Reader → Splitter → Embedder/Captioner → Indexer → Retriever → Reranker → Synthesizer`. Pre-built pipelines for each named strategy; students compose custom pipelines by mixing stages. | Composability *is* part of the lesson. Multimodal/video/long-doc pipelines naturally share stages (embedders, indexers); discrete-strategy modules would duplicate. Closer to LangChain/LlamaIndex shape but scoped tight to the playground. |
| 2 | **Model is a pipeline-stage parameter, not a global setting.** Cost is a first-class metric — every stage that hits a model declares input/output token counts (or vision API calls), and the comparison view in Phase 8 surfaces total $ per query alongside accuracy/latency. | Lets students compare "Anthropic vision vs local mlx-vision on the same multimodal PDF" with cost in the picture, not as an afterthought. The lesson "vision is great but expensive" only lands if cost is visible. |
| 3 | **Storage budget: not enforced per-student.** Local Mac Studio host; disk is cheap relative to model-inference cost. | Lets students iterate freely without an unrelated quota error. Add cleanup tooling later if needed. |
| 4 | **Two-tier corpus model**: instructor-shared (read-only across class) + student-private. Instructor pre-ingests big shared corpora once; students get their own private space for personal experiments. | Avoids 25× redundant ingest of a 500-page textbook. Sharing is the natural collaborative-classroom shape; per-student-private respects the lab-experiment privacy boundary. |
| 5 | **Pluggable stage interface.** Each stage is a class implementing a small interface (`process(input) → output`); custom stages can be dropped in `groups/<draft>/knowledge/stages/` and the pipeline framework picks them up. | Required for the "build your own strategy" capstone lab (still open — Decision 6 below). |

### Decisions still open

| # | Question | Notes |
|---|----------|-------|
| 6 | **Lab sequence** — what order do students hit the content types? Linear (text → code → PDF → video → graph) or thematic (build a course-textbook expert using all techniques)? | Affects which pipeline stages need to ship in the first cut vs. as fast-follows. Mark for further discussion. |
| 7 | **"Build your own strategy" capstone** — final lab where students write a custom stage module? | If yes, the plugin interface needs documentation + an example "skeleton stage" to copy. If no, ship a fixed set of stages. Mark for further discussion. |
| 8 | **Async-ingest UX** — long ingests (a 500-page textbook + figure captioning) take real minutes. Background-job queue with progress UI? | Required for video and large multimodal PDFs. Probably yes; spec'd at Phase 7 implementation time. |
| 9 | **Cost tracking implementation** — needs the agent-runner to emit token counts, which it doesn't track in `outbound.db` today. | Mentioned in Phase 4 too. Likely a small follow-up plan rather than bundled here. |
| 10 | **Per-student Anthropic auth — extend `/add-classroom-auth` or new sibling skill?** Existing skill handles Codex only; we now also need Anthropic API key + OAuth flows. | (a) refactor `/add-classroom-auth` into multi-provider shape vs. (b) add `/add-classroom-anthropic-auth` parallel skill. Lean (a). Spec'd in Phase 4's "Provider settings" sub-section. |

A new tab on the home page where each student builds and explores a
"knowledge source" attached to their agent — the modern descendant of
classical expert systems, where the question becomes "how do I get
*this* corpus into the agent's effective context?"

The pedagogical hook: there is no single right answer. Pure RAG (embed
+ retrieve) is one approach; long-context dumping, agentic search,
graph-of-knowledge, hierarchical summarization, BM25, and hybrid
schemes all have different strengths. Students pick a strategy, ingest
content, and *measure* (Phase 8) which works best for their queries.

### Pipeline framework + initial stage catalogue

The pipeline is a directed list of stages. Each stage takes typed
input, produces typed output, and declares its cost (token counts,
vision-API calls). A "strategy" is a named pre-built pipeline; a
custom pipeline is a list of stages students assemble.

```
Reader  →  Splitter  →  Embedder/Captioner  →  Indexer
                                                  ↓
                       Reranker  ←  Retriever  ←──┘
                          ↓
                      Synthesizer
```

**Stage taxonomy (initial):**

| Stage | Examples | Cost shape |
|---|---|---|
| **Reader** | text-file, markdown, web-scrape, pdf-marker, pdf-nougat, pdf-page-as-image, video-yt-dlp+ffmpeg, drive-folder, github-repo | bytes in, structured units out; cheap |
| **Splitter** | fixed-size, sentence-aware, heading-outline, code-symbol, video-scene-boundary, pdf-page | unit-count growth |
| **Embedder/Captioner** | openai-text-embedding-3-small, mlx-text-embed (local), claude-vision-caption, mlx-vision-caption (local), whisper-transcribe (local) | TOKENS or VISION_CALLS — first place real $ shows up |
| **Indexer** | chromadb, qdrant, lance, bm25-ripgrep, neo4j-graph, hnsw-flat | storage + ingest CPU; query latency varies |
| **Retriever** | top-k-cosine, bm25, hybrid-rrf, graph-walk, hierarchy-descent, agentic-grep (no-op pre-ingest) | per-query latency |
| **Reranker** | none, cross-encoder-local, claude-rerank, llm-judge | tokens × candidates |
| **Synthesizer** | direct-context-stuff, summary-then-answer, multi-hop-agentic, cite-and-answer | tokens; same model as the agent itself |

Each stage is a class implementing:

```ts
interface PipelineStage<In, Out> {
  name: string;
  configSchema: ZodSchema;
  cost(input: In, config: Config): CostEstimate;
  ingest?(input: In, config: Config, log: LogStream): Promise<Out>;
  query?(query: Query, state: PipelineState, config: Config): Promise<Out>;
}
```

Stages live at `src/knowledge/stages/<name>.ts`. Custom stages added
to a draft go at `groups/<draft>/knowledge/stages/<name>.ts` —
auto-discovered by the pipeline framework. (This is the open
Decision 7 hook — if we ship "build your own stage" as a capstone
lab, this is its plug-in point.)

### Pre-built pipelines (named strategies)

Each is a stage list + default config. Students start from one of
these and tweak.

| Pipeline | Stages | Best for |
|---|---|---|
| **agentic-search** | (none — agent reads raw on demand) | Code, small text corpora |
| **filesystem-wiki** | text-reader → markdown-splitter | Markdown notes, mid-size text |
| **vector-text** | text-reader → sentence-splitter → text-embedder → chromadb-indexer → top-k → direct-stuff | Standard text RAG baseline |
| **sparse-bm25** | text-reader → token-splitter → bm25-indexer → bm25-retriever → direct-stuff | Code, exact-term search |
| **hybrid-rrf** | text-reader → sentence-splitter → (text-embedder + bm25-indexer) → hybrid-rrf-retriever → cross-encoder-rerank → direct-stuff | Mixed precision/recall needs |
| **long-context** | text-reader → fits-context-splitter → direct-stuff (no retrieval) | Anything that fits in 200k tokens |
| **hierarchical-tree** | text-reader → heading-outline-splitter → recursive-summarize → tree-descent-retriever → direct-stuff | Long structured docs (textbooks) |
| **multimodal-pdf** | pdf-marker-reader → page+figure-splitter → (text-embedder + vision-captioner) → chromadb-indexer → top-k → direct-stuff | PDFs with figures/tables |
| **vision-pdf** | pdf-page-as-image-reader → page-splitter → vision-captioner → chromadb-indexer → top-k → direct-stuff | Slide decks, figure-heavy PDFs |
| **video-transcript** | video-yt-dlp-reader → whisper-transcribe → sentence-splitter → text-embedder → chromadb → top-k-temporal | Lecture videos, podcasts |
| **video-multimodal** | video-yt-dlp-reader → scene-splitter → (whisper-transcribe + frame-vision-captioner) → chromadb → top-k-temporal | Lectures with on-screen content |
| **graph-rag** | text-reader → entity-extract → graph-indexer (neo4j or in-mem) → graph-walk-retriever → direct-stuff | Relational queries; uses mnemon as primitive |

**Recommended first-class cut:** `agentic-search`, `filesystem-wiki`,
`vector-text`, `sparse-bm25`, `hybrid-rrf`, `long-context`,
`multimodal-pdf`, `video-transcript`. Eight pipelines covers the
five-content-types matrix (text, code, simple-PDF, multimodal-PDF,
video-transcript) plus the discrete-vs-continuous-retrieval axis.
Hierarchical, vision-pdf, video-multimodal, graph-rag as
fast-follows; each is a separate "build my own pipeline" student
exercise.

### Two-tier corpus model

```
data/class-shared/corpora/<name>/                  ← instructor-ingested, read-only
  raw/                                              ← original files
  pipelines/<pipeline-name>/                        ← per-pipeline ingested artifacts
    chunks.jsonl
    embeddings.bin
    bm25.idx

groups/<student-draft>/knowledge/sources/<id>/      ← student-private
  raw/                                              ← uploaded by the student
  pipelines/<pipeline-name>/                        ← their ingest
  pipeline.json                                     ← stage list + config
```

**Sharing rules:**

- Student drafts can attach a *shared* corpus → reads from
  `class-shared/`, no re-ingest. Read-only.
- Student drafts can also have private sources, ingested into their
  own folder. Read+write to that source only.
- Instructor-side: `class-skeleton.ts` learns a `--corpus <path>`
  flag for pre-ingesting shared corpora at provisioning time.

**Why shared makes sense here:** A 500-page textbook ingested via
multimodal-pdf with vision captioning could be ~$5–10 per ingest
(or hours of local-vision time). Re-ingesting per student × 25 is
silly. Instructor pays once; students attach + experiment.

### UI panel

The Expert System tab has four sub-views:

1. **Pipelines** — list current sources (private + shared) with
   their pipeline. New source: upload file / pick shared corpus /
   pick from Drive (Phase 3) / scrape URL.
2. **Pipeline editor** — visual stage chain; pick a pre-built
   pipeline or compose. Each stage shows config form + estimated
   cost given input size.
3. **Ingest log** — live progress for in-flight ingests (SSE).
   Background-job queue (Decision 8 still open).
4. **Inspect** — browse ingested artifacts: chunk previews,
   graph viz, hierarchy tree, frame thumbnails for video,
   per-page captions for multimodal-PDF.

### API

```
POST   /api/draft/<folder>/knowledge/sources                — create (private) or attach (shared)
PUT    /api/draft/<folder>/knowledge/sources/:id/upload     — multipart upload (private only)
PUT    /api/draft/<folder>/knowledge/sources/:id/pipeline   — update pipeline config + re-ingest
DELETE /api/draft/<folder>/knowledge/sources/:id            — discard (or detach if shared)
GET    /api/draft/<folder>/knowledge/sources/:id/inspect    — pipeline-specific preview
GET    /api/draft/<folder>/knowledge/sources/:id/log        — ingest log (SSE)
GET    /api/class-shared/corpora                            — list shared corpora
GET    /api/class-shared/corpora/:name/cost                 — estimated cost to ingest with pipeline X (instructor-only)
```

### Files

- `src/knowledge/pipeline.ts` — orchestrator. Loads pipeline JSON,
  resolves stages from registry + custom-stage folder, runs
  ingest/query.
- `src/knowledge/stages/` — built-in stages (one file per stage).
- `src/knowledge/cost.ts` — cost-tracking primitives. Stages declare
  cost; framework aggregates per ingest + per query.
- `src/knowledge/pipelines/` — pre-built pipeline JSON specs (one
  file per named strategy).
- `src/channels/playground/home/expert-system-pane.{html,js,css}` — UI.
- `src/channels/playground/api-knowledge.ts` — REST.

### Hours est

TBD — depends on Decision 6 (which pipelines are first-class) and 7
(custom-stage support). Rough order-of-magnitude:

- **Framework + 4 baseline pipelines** (agentic-search,
  filesystem-wiki, vector-text, long-context): ~12–15 hr.
- **Multimodal-PDF + video-transcript pipelines**: +6–8 hr each
  (the readers/splitters/captioners are real new work; mlx-vision
  and mlx-whisper integration adds an extra hour or two).
- **Hybrid + sparse + hierarchical + graph + vision-pdf +
  video-multimodal**: another 4–6 hr each as fast-follows.
- **Custom-stage support** (Decision 7 = yes): +3–4 hr (interface
  doc + skeleton + auto-discovery).

---

## Phase 8 — Evaluation framework (the lab piece)

Phase 7 gives students *strategies*. Phase 8 gives them a way to
*compare* strategies on real queries — the actual pedagogical payload.

**Mental model: per-source experiments.**

```
experiment {
  draftFolder
  sources[]       — one or more from Phase 7 (or "no source" baseline)
  queries[]       — the question set
  judge           — optional LLM-as-judge config
  results[]       — {sourceId, queryId, response, latency, tokens, retrieved, score}
}
```

A student picks 2–4 sources to compare, picks (or writes) a query
set, hits Run. The framework fires each query against each source,
records everything, and shows side-by-side results.

**API:**

```
POST  /api/draft/<folder>/experiments              — create experiment
PUT   /api/draft/<folder>/experiments/:id/run      — start run (SSE for progress)
GET   /api/draft/<folder>/experiments/:id          — view results
GET   /api/draft/<folder>/experiments/:id/export   — JSON / CSV
```

**Query-set sources:**

- **Pre-canned** — instructor uploads a CSV per assignment: `query, expected_answer, category`. Lives in `data/class-shared/queries/<assignment>.csv`, symlinked into student folders the same way `class-shared-students.md` is today.
- **Student-authored** — text editor in the UI; student writes their own.
- **Auto-generated** — for advanced labs: an LLM generates queries from the corpus itself ("synth eval"). Risky as a primary metric but useful for exploration.

**Scoring:**

Three modes, students pick:

1. **No score** — just side-by-side responses; the student eyeballs which is better. Good for small query sets.
2. **String / regex match** — instructor's expected_answer column is a substring or regex; binary pass/fail. Cheap and reproducible.
3. **LLM-as-judge** — use a separate model invocation (Anthropic Sonnet, or local model in Phase 6 if instructor doesn't want billable judge calls) to rate response vs expected. Returns a score 0–1 with rationale. Slower and stochastic but handles open-ended answers.

Mode 3 should be off by default; instructors enable it explicitly per lab.

**UI:**

Experiment-results view as a table:

|  | Source A: Vector | Source B: Wiki | Source C: Agentic |
|---|---|---|---|
| Q1: "What is X?" | ✅ 0.92 (1.2s, 850 tok) | ✅ 0.88 (3.1s, 4200 tok) | ❌ 0.41 (8.7s, 2100 tok) |
| Q2: "Why does Y?" | ❌ 0.32 | ✅ 0.95 | ✅ 0.81 |
| ... |

Click a cell → see the actual response, retrieved chunks, judge
rationale. Click a column header → see strategy params.

**Files:**

- `src/eval/index.ts` — runner. Iterates queries × sources,
  invokes the agent with each source attached, captures everything.
- `src/eval/judge.ts` — LLM-as-judge invocation; routes through
  the existing provider abstraction so it works with Anthropic +
  local models.
- `src/db/migrations/017-experiments.ts` — `experiments` and
  `experiment_results` tables.
- `src/channels/playground/home/experiment-pane.{html,js}` — UI.

**Hours est:** ~8–10 hr including a comparison-view UI that's actually
useful. Less if students are okay with raw JSON output for the first
iteration.

---

---

## Phase 9 — Walk-away cloud deploy

End-of-course capstone: a "Walk Away" button on the home page that
turns the student's playground state — agent, knowledge sources,
experiments — into a running NanoClaw instance on a cloud server they
own. They leave the course with a working agent, not a tarball.

**Three deploy modes, instructor decides which to support:**

1. **BYO-cloud (default, recommended)** — student provisions a VPS
   themselves (DigitalOcean / Hetzner / Linode / a Mac Mini at
   home), runs one bootstrap command. Class server hosts only the
   bundle + verification.
2. **Auto-provision** — instructor's class server holds API
   credentials for a cloud provider, mints a VPS on the student's
   behalf. Faster but the instructor pays for VPS billing or has a
   pre-arranged student-billing flow.
3. **Local-only fallback** — student downloads a tarball + a
   `setup.sh` and runs it on their own laptop / home server. No
   class-server involvement at deploy time.

Phase 9 implements **mode 1** in trunk (the others are layerable
follow-ups).

**Walk-away flow:**

```
Student clicks "Walk Away" on home page
  → confirms what's bundled (agent, knowledge, experiments)
  → confirms target: "I have a fresh Ubuntu/macOS machine ready"
  → class server mints a one-time install token (24h TTL)
  → home page shows:
       ssh user@your-server.com
       bash <(curl https://class.example.com/walkaway?t=ABC123)
  → student runs that on their server
  → bootstrap script:
       1. clone NanoClaw
       2. run setup (the existing nanoclaw.sh flow, no
          interactive prompts — config from token bundle)
       3. fetch student's bundle from class server (token-authed)
       4. import: agent_groups, knowledge sources, experiments,
          container.json, CLAUDE.local.md, persona, skills
       5. prompt student for THEIR creds:
            - their own bot token (or skip Telegram)
            - their own Anthropic key (or codex auth, or
              local-LLM endpoint URL)
            - their own GWS account (re-do the OAuth dance —
              the class instance's per-student refresh token
              is NOT exportable for security)
       6. start the service
  → student has a working agent on their own infra in ~10–15 min
```

**Bundle contents** (extends Phase 5's export):

```
walkaway-<student>.tar.gz
  manifest.json              version, schema, what's included
  groups/<their-folder>/     agent persona, container.json, skills
  knowledge/                 ingested sources from Phase 7
  experiments/               their experiment history (optional)
  setup-config.json          channel + provider config the import
                             script applies non-interactively
```

**Security boundaries — what is NOT exported:**

- Per-student GWS refresh tokens (Phase 3) — must be re-acquired on
  the new server. Same boundary Google enforces; we don't break it.
- The class server's OAuth client — student needs their own GCP
  project and client. Documented in the post-deploy README.
- Other students' agent groups, even if the role gates would let
  them see them in the class playground. Walk-away is strictly
  per-student.
- The class roster, instructor identity, other students' personas.

**API:**

```
POST  /api/home/walkaway/prepare       — generates bundle, returns token
GET   /walkaway?t=<token>              — bootstrap script (text/plain bash)
GET   /walkaway/bundle?t=<token>       — bundle download (single-use, then revoked)
```

The bootstrap script is dynamically rendered with the bundle URL
embedded; it's not a static asset. The token is single-use for the
bundle download and burns on first fetch.

**Files:**

- `src/walkaway/index.ts` — bundle generator (extends Phase 5).
- `src/walkaway/bootstrap.sh.ts` — bash-script template renderer.
- `src/walkaway/import.ts` — runs on the new server; reads bundle,
  populates DB, runs migrations.
- `src/channels/playground/home/walkaway-pane.{html,js}` — UI.
- `.claude/skills/add-classroom/SKILL.md` — operator-side notes on
  enabling the feature (which deploy modes, bundle TTL, etc.).

**Hours est:** ~6–8 hr. The bundle format is mostly Phase 5's work
extended; the bootstrap-script + import side is the new work.

**Out of scope for Phase 9:**

- Auto-provisioning a VPS (mode 2 above) — separate skill,
  layerable, post-Phase-9.
- Importing a bundle into an *existing* NanoClaw install (i.e.,
  merge with their already-running setup) — adds conflict-resolution
  surface; defer until requested.
- Cloud-cost optimization, autoscaling, monitoring — those are
  general-purpose-cloud concerns and belong in the user's hosting
  setup, not in this plan.

---

## Classroom / lab scenario ideas

How the Phase 7 + 8 stack actually gets used in a course. These are
prompts for course design rather than implementation requirements:

**Lab 1: Same corpus, different strategies.** Provide one PDF (e.g.,
a course chapter). Each student ingests it with all 4 default
strategies (filesystem, agentic, vector, long-context). Runs the
same 10 queries against each. Reports: which strategy was best
overall, where each was worst, why.

**Lab 2: Strategy parameter sweep.** Pick one strategy (e.g.,
vector). Vary one parameter at a time (chunk size, k, embedding
model). Find the optimum for a fixed query set. Plot results.

**Lab 3: Cross-strategy ensembles.** Use two strategies in
combination (vector for high-precision lookup, agentic Grep for
fallback). Implement the routing logic in a custom skill. Compare
to single-strategy baselines.

**Lab 4: Hostile queries.** Instructor provides a corpus + 20
queries, half answerable from the corpus, half adversarial
("hallucination bait" — questions whose answers aren't in the
corpus). Score = correct + correctly-says-don't-know. Different
strategies fail differently here; teaches the practical limit
of "just throw more docs at it."

**Lab 5: The student's own corpus.** Each student picks a domain
they care about (their hobby, their other course, their personal
notes) and builds an "expert in X" agent. Final deliverable is the
agent export (Phase 5) + their evaluation results.

**Lab 6: Compare against humans.** Same corpus + queries used
elsewhere in the course (e.g., reading assignment + comprehension
quiz). Student configures an agent to score well on the quiz.
Surfaces tradeoffs between memorization, retrieval, and reasoning.

**Cross-cutting design choices for the labs:**

- **Pre-canned starting kits** — instructor pre-loads sources/queries
  the student can clone with one click. Lowers the "blank-page"
  barrier for Lab 1; advanced labs let students build from scratch.
- **Reproducibility as a first-class output** — each experiment
  exports as a JSON spec + results CSV. Students share, instructors
  grade, future students see prior runs.
- **Leaderboard (optional)** — anonymized scoreboard per assignment.
  Friendly competition, also surfaces "this strategy scored 0.2
  higher than the next-best on this corpus" patterns.
- **Time + cost tracking** — Phase 8 records latency and token
  counts. Strategies that win on accuracy often lose on cost; the
  comparison view should make that tradeoff visible.
- **Local-LLM friendly** — running 25 students × 4 strategies × 10
  queries × 1 judge call = ~1000 inference calls per assignment.
  Phase 6's local-LLM path is cost-essential here; the student
  comparing 4 strategies on a vector store doesn't need Claude
  Opus to do it.

---

## Hosting / TLS

Out of scope for code, but on the path for any real deployment:

- **Caddy reverse proxy** — single-file install, Let's Encrypt auto-cert,
  one config block:
  ```
  class.example.com {
    reverse_proxy 127.0.0.1:3002
  }
  ```
- **Cloudflare Tunnel** — if the Mac Studio is behind NAT (likely on a
  home/office network). Free, no port-forwarding, automatic TLS.
- **`PLAYGROUND_BIND_HOST=127.0.0.1`** once a reverse proxy is in
  front — keeps the playground off the public interface entirely.

Document one path in the `/add-classroom` skill so instructors don't
end up exposing plain HTTP.

---

## Phased plan

| Phase | What | LoC est. | Hours |
|-------|------|---------:|------:|
| 1 | Multi-user session store | ~80 changed in `playground.ts` + ~150 new test | 4–5 |
| 2 | Google OAuth + roster + minimal home page | ~300 new + migration + skill flag | 7–9 |
| 3 | Per-student GWS refresh token persistence + proxy lookup | ~150 new | 3–4 |
| 4 | Home page expansion (settings, dashboard, provider settings + per-student auth, picker filter) | ~600 new (UI-heavy + per-student auth wiring) | 9–12 |
| 5 | Agent export (nanoclaw / claude-code / codex / json) | ~250 new | 4–5 |
| 6 | Local-LLM via codex provider (audit + runbook) | ~50 changed + docs | 2–3 |
| 7 | Expert system builder tab + default strategies (scope tbd) | tbd — see "RAG phase open design" below | tbd |
| 8 | Evaluation framework + comparison UI | ~500 new + migration | 8–10 |
| 9 | Walk-away cloud deploy (BYO-cloud mode) | ~400 new + bootstrap.sh template | 6–8 |
| Hosting | Document Caddy / Cloudflare Tunnel in skill | docs only | 1 |

Total: ~52–66 hours for the full set (Phase 7 hours TBD pending
RAG-design discussion); ~16 hours for the bare-minimum (Phases 1 + 2
+ 3) classroom-deployable cut.

Each phase ends with passing tests and a focused commit.

## Sequencing decision

**Phase 1 is the unblocker** — without it, any classroom deployment
beyond 1 student is broken. Ship Phase 1 first as a trunk fix on
`/add-agent-playground` (channels branch). Anyone using the playground
without classroom benefits from a multi-user fix that's not bundled
with class-specific OAuth.

**Phases 2 + 3 land together** (one OAuth dance, two outcomes) —
splitting them into two PRs would waste the integration work.

**Phase 4 (home page expansion) gates the polish, not the function.**
Phase 2 ships a usable home page (login + "Open Playground" link); a
class CAN run on Phases 1+2+3 alone. Phase 4 is the experience upgrade.

**Phases 5 + 6 are independent and can ship in either order**, after
Phase 4. Phase 5 (export) is a self-contained backend feature.
Phase 6 (local-LLM) is mostly a runbook + small audit; it doesn't
block any other work.

**Phases 7 + 8 are the "lab" payload** — they define what students
*do* in class beyond persona-tweaking. Phase 7 is the bigger build
(strategy implementations); Phase 8 makes Phase 7 pedagogical (no
point comparing strategies if you can't measure them). Both depend
on Phase 6 in practice — running 25 students × multiple strategies
× many queries against billable models gets expensive fast.

**Phase 9 is the capstone** — student walks away with a working
agent on their own infra. Depends on Phase 5 (export tooling);
independent of Phases 6–8 (a student without lab content can still
walk away with their persona-tweaked agent).

**Recommended cut for "first class":**

- Phases 1 + 2 + 3 + Hosting docs (= deployable MVP) → ~16 hr
- Phase 6 if local-LLM is committed → +3 hr
- Phase 4 + 5 as fast-follows in the gap between provisioning and
  first lecture
- Phase 7 + 8 if the course is RAG/expert-systems focused →
  +tbd, and probably the bulk of the second-half-of-semester
  lab content. RAG-phase scope is still open — see discussion
  thread before locking.
- Phase 9 (Walk Away) at end of semester regardless of which other
  phases ship — the export bundle works for any agent state, with
  or without Phase 7/8 lab data.

## Risks

| Risk | Mitigation |
|------|------------|
| Cookie session map grows unbounded if students don't log out | Idle sweep on 1-min interval (already in scope); cap session count + LRU evict if hit. |
| Google OAuth refresh-token rotation | `gws-auth.ts` already handles rotation; per-student creds.json is rewritten on rotation. |
| Roster CSV becomes the source of truth and drifts from `agent_groups` | `class-skeleton.ts` is the only writer; running it always rebuilds the roster from the same `--names`/`--instructors`/`--tas` it provisions. |
| Student in roster but no agent group | Migration error — surface at `/add-classroom` time, not at student-login time. |
| Instructor's Drive accidentally exposed during the Phase 2-only window (no Phase 3 yet) | Phase 2 + 3 ship together. There IS no Phase-2-only window. |
| TLS cert on Mac Studio public deployment | Caddy/Cloudflare Tunnel setup documented in the classroom skill before first class. |

## Open questions

- **TA/instructor login flow** — they have Telegram, so `/playground`
  magic link still works. Do they want the Google login path too
  (e.g., for use from a phone without Telegram set up)? Probably yes —
  same code path, just check role instead of `student_NN`.
- **Multi-tab per student** — same student opens two tabs. Two
  cookies, two sessions, both authed. Probably fine but worth a
  shrug-and-document moment. v1 had a single-active lock; v2's
  multi-user store removes the *cross-user* lock but leaves the
  *cross-tab* possibility open.
- **Session revocation when removing a student** — delete from roster
  → existing session cookie keeps working until idle expiry. Add
  `revokeSessionsForUser(userId)` for the admin-side remove flow.
- **Codex export format compatibility** — the `AGENTS.md` convention
  is documented in this repo's own `AGENTS.md`; whether external
  Codex tooling reads it is unknown. Verify before Phase 5 ships;
  worst case, drop the codex target and ship JSON + Claude Code +
  nanoclaw.
- **Token-usage tracking in `outbound.db`** — Phase 4's dashboard
  wants per-student token counts. The DB doesn't track them today.
  Either add that to the agent-runner first (small change) or ship
  Phase 4's dashboard with a "tokens coming soon" placeholder.
- **Telegram link UX** — Phase 4 lets a student opt into Telegram
  notifications. What gets pushed to Telegram once linked? Probably:
  request_reauth nudges, long-running task completion, agent-to-agent
  handoff results. List the events explicitly during Phase 4 design.
- **Concurrency on local LLM (Phase 6)** — 25 students hitting one
  Mac Studio. Sizing is empirical; bench mlx-omni-server against
  Qwen 2.5 32B Q4 with `--batch` before committing a course schedule
  around it.
- **Vector-store choice (Phase 7)** — Chromadb is the easy default
  (in-process, file-backed, no separate daemon). Qdrant or LanceDB
  if students need bigger corpora. Decision can be deferred to
  Phase 7 implementation; the strategy module abstracts it.
- **Embedding model for vector RAG (Phase 7)** — `text-embedding-3-small`
  via codex provider works but burns the OpenAI key (or local mlx
  embedding via mlx-omni-server). Picking one default + letting
  students pick alternatives is the right shape; choosing the
  default is a Phase 7 sub-decision.
- **LLM-as-judge model selection (Phase 8)** — using the same model
  as the agent under test biases the score. Need a separate "judge"
  config: probably Anthropic Sonnet by default, with an option to
  use a local model in fully-local-LLM deployments.
- **Lab corpus copyright** — instructor uploads pre-canned datasets;
  students upload their own. Default policy: per-student folders
  are private to that student + scoped admins; class-shared corpora
  read-only for students. Document the boundary explicitly so
  students don't accidentally upload copyrighted material into a
  shared space.

## Out of scope (for this plan)

- gws-mcp Phase 13 (the actual Doc read/write tools) — separate plan
  in `plans/gws-mcp.md`. Phase 3 here just makes Phase 13 safe for
  classroom; Phase 13 is when the tools become useful.
- Apple Container migration — orthogonal, runs on Docker today, can
  swap any time via `/convert-to-apple-container`. The plan works
  regardless of runtime.
- Per-student token-usage / cost dashboard with real numbers — Phase
  4 has a placeholder; the agent-runner change to record tokens is a
  small follow-up plan, not bundled here.
- Course content management (lectures, assignments, grading) — this
  plan delivers the *workbench*; what students DO with it is course
  design, separate from infrastructure.

## Naturally layered skills (after this plan)

These compose with the plan's output but ship as their own skills,
post-deployment. Listed so they're not lost — each is small enough
to be a sibling skill, large enough to deserve its own plan when
the time comes.

### `/add-classroom-wiki` — shared class knowledge base

Combines `/add-karpathy-llm-wiki` with the classroom infrastructure
to give the whole class one shared, contributor-attributed wiki:

- **Shared mount**: `data/class-shared/wiki/` on the host, bind-mounted
  RW into every student / TA / instructor container at
  `/workspace/wiki`. Same skeleton-mount-registry pattern
  `/add-classroom-gws` uses for Drive folders.
- **Per-student git identity** (already configured by `/add-classroom`)
  attributes every wiki commit to the real student's name + email.
  The audit trail is git history.
- **Wiki skill** (already shipped as `/add-karpathy-llm-wiki`'s
  container skill) instructs the agent to `git pull → edit → git
  commit` for every contribution. The per-edit-commit discipline is
  load-bearing for multi-writer correctness — without it, two
  containers writing the same file at once produce a lost update.
- **Role-aware moderation** (optional Phase 2 of the wiki skill):
  TAs and instructors get extra wiki tools (revert, lock-page,
  resolve-conflict) gated through the existing `canAccessAgentGroup`
  primitive. Students contribute only.
- **Discovery on home page**: a "Class Wiki" link in the Phase 4
  home page sidebar, opens an external read-only HTML render of
  the wiki (just `git log` + Markdown render of `wiki/index.md`).
  No editing UI — students contribute through their agent, not
  through a wiki editor. Keeps the agent the primary surface.

Estimated: ~6–8 hr. Skill spec lives in `plans/classroom-wiki.md`
when it's time.

### `/add-classroom-anthropic-auth` (or refactored `/add-classroom-auth`)

Per-student Anthropic API key + OAuth handling, parallel to the
existing Codex per-student auth. See Decision 10 in the open
questions for the refactor-vs-sibling choice. Shipped alongside
Phase 4 of this plan if Decision 10 lands as "new sibling skill,"
or absorbed into `/add-classroom-auth` if it lands as "refactor."

### `/add-rag-lab` — generalized expert-system builder

Phase 7 + 8 ship as `/add-classroom-rag` because the pedagogical
framing (instructor pre-ingests shared corpora; per-student-private
sources) is class-specific. A generalized version that strips the
class roster + role gates would be useful for solo NanoClaw
operators experimenting with strategies. Probably ships as
`/add-rag-lab` once `/add-classroom-rag` proves the pattern.
