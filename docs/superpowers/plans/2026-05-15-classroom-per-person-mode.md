# Classroom Per-Person Mode — Implementation Plan

> **For agentic workers:** This is an INDEX plan — it sequences the
> 10 Phase-2 build-order items already detailed in
> `plans/master.md` and the linked sub-plans, and adds the
> Phase 1.5 preconditions that shipped 2026-05-15. Each line links
> to the sub-plan with the actual TDD steps. Do NOT duplicate those
> steps here — open the sub-plan when you implement the slice.

**Goal.** Land Phase 2 (per-person classroom mode) as a sequence of
small, independently-shippable slices on top of the Phase 1
shared-classroom MVP.

**Architecture.** Builds on existing primitives: credential-proxy
header-based attribution, class-login-tokens, classroom_roster,
per-group container.json. Adds per-student credential-store tiers
(GWS + provider), magic-link OAuth flows, temp-code fallback, and a
student-facing provider-settings UI. Design rationale + cross-links:
[`docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md`](../specs/2026-05-15-classroom-per-person-mode-design.md).

**Tech stack.** Same as trunk — Node host + Bun container + SQLite
session DBs. New work touches `src/gws-token.ts`, `src/credential-
proxy.ts`, `src/channels/playground/public/`, and the
`/add-classroom*` skill family.

---

## Phase 1.5 — Post-class polish (SHIPPED 2026-05-15)

- [x] Per-call `model_call` trace events — codex multi-tool turn
      breakdown — commit `3a10c16`
- [x] Auto-refresh codex catalog from `developers.openai.com` —
      commit `9a1769c`
- [x] Claude support in direct-chat (Anthropic Messages wire
      format) — commit `9400e2a`
- [x] Provider/model sync on `/provider` switch — included in `08ae3d1`
- [x] Chat-tab model dropdown PUTs `active-model` + respawn modal —
      included in `08ae3d1`
- [x] Persona refresh + dad-joke quirk on all student personas —
      `08ae3d1` (scripts/refresh-student-personas.ts)
- [x] Raccoon-unicycle rebrand to "Agent Playground" — commit `6d0ecac`
- [x] `.gitignore` class-roster.csv + remove wire-test-student.ts —
      commit `37dbdad`

---

## Phase 2 — Per-person mode build order

Order matches `plans/master.md` §"Phase 2 — Full classroom capability".

- [ ] **Phase 14 — per-person GWS OAuth.** Per-student Google
      account connection from the playground home tab. UX pattern
      mirrors the existing Telegram "Connect Telegram" card. PIN
      stays as the identity path; this is opt-in resource auth.
      Instructor bearer remains as fallback for anyone who hasn't
      connected. Detail expanded below; legacy text in
      [`plans/gws-mcp.md` §Phase 14](../../../plans/gws-mcp.md).

  **Prereqs (operator, GCP Console — ~5 min, blocking):**
    - [ ] Add redirect URI `http://130.127.162.180:3002/google-auth/callback`
          to the existing OAuth client (identified by `client_id`
          in `~/.config/gws/client_secret.json`).
    - [ ] OAuth consent screen: scopes include `drive`,
          `gmail.modify`, `calendar`. (Drive already there from
          the original install; gmail + calendar are new.)
    - [ ] OAuth consent screen → Test users: add the 10
          `@clemson.edu` student addresses (Restricted scopes
          require allowlisting until app is verified — out of
          scope for 10 students).

  **Policy for unconnected students.** Mode A (today's shared-
  classroom) already gives every student the ability to create
  Docs/Sheets/Slides in the instructor's Drive and read/edit
  the ones THEY created, via the `nanoclaw_owners` ownership-
  tag primitive installed by `/add-classroom-gws`. Phase 14
  does NOT remove that — it adds an OPTIONAL per-student
  write target. The split:

    - **Drive / Sheets / Slides** (`drive_doc_*`, `sheet_*`,
      `slides_*`): unchanged for unconnected students — same
      Mode A behavior (instructor bearer + ownership tags
      keep student artifacts isolated). Connected students:
      new artifacts go into THEIR Drive instead of the
      instructor's. Both paths coexist; the resolver picks
      per-student token when present, falls back to instructor
      otherwise. Previously-created instructor-Drive artifacts
      stay where they were — no migration.
    - **Gmail** (`gmail_*`, new in Tier C): **gated**. There's
      no class-shared inbox to fall back to, and reading the
      instructor's inbox makes no sense.
    - **Calendar** (`calendar_*`, new in Tier D): **gated**
      for both reads and writes. No class-shared calendar to
      fall back to.
    - **`/workspace/drive/` rclone bind mount**: unchanged —
      still backed by instructor bearer, exposing the per-
      student folder. Filesystem path, not an MCP tool.
    - **Chat, wiki commits, persona editing, skills, agent
      loop itself**: unaffected; the agent is fully usable
      without a Google connection.

  When a gated tool (Gmail / Calendar) fires for an unconnected
  student, it returns a structured error: `connect_required`
  with a human-readable message pointing them at the home-tab
  "Connect Google" card. The agent surfaces this verbatim
  rather than retrying. The non-gated Drive tools never error
  on the connection state — they just route differently based
  on what's available.

  **Tier A — Foundation (SHIPPED 2026-05-15, commits `ab90d0b`..`bd479c6`).
  Wires the credential writer + UI + resolver. The gate behavior
  lands per-tool in Tier B/C/D so each tool ships with its own
  policy enforcement test. Tier A introduces no agent-runner
  behavior change — connected students don't see anything different
  until Tier C/D tools ship. The `/gauth` Telegram command (one of
  the six originally-planned sub-tasks) is DEFERRED — it lives in
  the gitignored `src/admin-handlers/` tree and is per-install
  opt-in via `/add-admintools`, not part of trunk Phase 14.**
    - [x] `src/student-google-auth.ts` — writer side: store
          per-student credentials at
          `data/student-google-auth/<sanitized_user_id>/credentials.json`.
          Reader side already exists at `src/student-creds-paths.ts`
          and `src/gws-token.ts:159`. Functions:
          `writeStudentCredentials(userId, tokens)`,
          `hasStudentCredentials(userId)`,
          `loadStudentCredentials(userId): GwsTokens | null`,
          `clearStudentCredentials(userId)` (for revoke flow).
    - [x] `src/gws-token.ts` — extend `getGoogleAccessTokenForAgentGroup`
          with an `options.requirePersonal: boolean` flag. When
          true, resolve user_id from `classroom_roster` by
          agent_group_id, try per-student credentials, return
          null if absent (no instructor fallback) — used by
          Gmail (Tier C) and Calendar (Tier D) tools. When
          false (the default, used by Drive/Sheets/Slides tools
          and the rclone bind mount), keep current behavior:
          try per-student first, fall back to instructor.
          Update returned `principal` to `"student:<user_id>"`,
          `"instructor"`, or `null` accordingly so per-call
          attribution surfaces correctly in proxy logs and usage
          aggregation.
    - [x] `src/channels/playground/api/google-auth.ts` — new
          handler module with two HTTP routes:
          `GET /google-auth/start` — verify session cookie,
          mint a state token bound to the user_id, build
          Google's consent URL with state + scopes
          (drive + gmail.modify + calendar), redirect.
          `GET /google-auth/callback` — verify state, exchange
          authorization code via `gws-auth.ts:exchangeCodeForTokens`,
          call `writeStudentCredentials(userId, tokens)`,
          redirect back to home tab with `?google_connected=1`.
    - [x] `src/channels/playground/server.ts` — register the two
          new routes (alongside the existing `/oauth/google/*`
          PIN-flow routes which serve a different purpose).
    - [x] `src/channels/playground/public/tabs/home.js` — new
          "Google" card mirroring `renderTelegramCard`. States:
          *not connected* → "Connect Google" button; *connected*
          → "Connected as `<email>` · Disconnect". Wire button
          to navigate to `/google-auth/start`; render
          `?google_connected=1` query-param as a transient
          success note.
    - [ ] `src/admin-handlers/gauth.ts` (gitignored — `/add-admintools`-
          installed) — new `/gauth` Telegram command. DMs the
          requester a one-click `/google-auth/start` link. Mirror
          of the existing `/playground` magic-link command.
    - [ ] Update `data/class-shared-students.md` — point students
          at the home-tab "Connect Google" card. No mention of
          required connection (it's optional).

  **Tier B — Drive tools route per-student when connected
  (SHIPPED 2026-05-15, commits `161589f`..`b320da0`. No gate —
  Mode A fallback preserved):**
    - [x] Verify existing `drive_doc_read_as_markdown` /
          `drive_doc_write_from_markdown` / `sheet_*` /
          `slides_*` tools route through the per-student
          credential when present, instructor bearer otherwise.
          Should fall out of Tier A's `gws-token.ts` change
          (default `requirePersonal: false` keeps the instructor
          fallback).
    - [x] Add a `principal` field to each tool's response
          metadata (e.g. `"student:alice@clemson.edu"` /
          `"instructor"`) so the agent / playground can surface
          "this Doc was created in your Drive" vs "this Doc was
          created in the class shared Drive" when listing
          artifacts. Useful for student awareness without
          forcing them to connect.
    - [x] Integration test: same tool call with and without a
          per-student credential — verify the resulting Doc
          lands in the correct Drive each time, and the
          response `principal` matches.

  **Tier C — Gmail tools (SHIPPED 2026-05-15, commits `88ac7e2`..`95d6d53`. Gated on personal connection):**
    - [x] Add `gmail_search`, `gmail_read_thread`,
          `gmail_send_draft` to `src/gws-mcp-server.ts`. All
          three call the resolver with `requirePersonal: true`;
          return `connect_required` for unconnected students.
          Draft tool returns a draft ID + compose URL; never
          auto-sends (UI-only confirmation).
    - [x] Add container-side shim in
          `container/agent-runner/src/mcp-tools/gws.ts`.
    - [x] Add `@googleapis/gmail` to host package.json (pinned).
    - [ ] Smoke test from a connected student's agent — DEFERRED,
          gated on operator's GCP Console step (redirect URI +
          test users + gmail.modify scope on consent screen).
          Unconnected-student gate is unit-tested.

  **Tier D — Calendar tools (SHIPPED 2026-05-15, commits `a924ea1`..`ee4af34`. Gated on personal connection,
  read + write both):**
    - [x] Add `calendar_list_events`, `calendar_create_event`,
          `calendar_find_free_slot` to `src/gws-mcp-server.ts`.
          All three gated with `requirePersonal: true` —
          there's no class-shared calendar to fall back to so
          even reads require the student's own connection.
    - [x] Container-side shim + `@googleapis/calendar` pinned.
    - [ ] Smoke test from a connected student's agent — DEFERRED,
          gated on operator's GCP Console step (same as Tier C).
          Unconnected-student gate is unit-tested.

  **Open question (revisit before Tier C):** auto-send or
  draft-only for Gmail? Drafts-only is the conservative
  default; the agent presents the composed draft + a compose
  URL the student opens to send manually. Auto-send would
  require its own confirmation pattern (approval primitive?).
- [ ] **credential-proxy Phase X.7 — per-student provider auth +
      instructor-controlled class-pool fallback.** Generalizes the
      Phase 14 resolver pattern across LLM providers (Anthropic /
      OpenAI / Local) with the addition of an explicit instructor
      toggle for fallback. **Shape locked 2026-05-17** after design
      discussion; details:

      **Class Controls (instructor):** per-provider, two toggles —
      `allow` ("can students use this provider at all?") and
      `pool_fallback` ("can students who haven't connected their
      own creds use the instructor's pool?"). Sensible defaults:
      OpenAI `allow=true, fallback=true`; Local `allow=true,
      fallback=true` (free); Anthropic `allow=true, fallback=false`
      (premium / scarce). Persisted in `class_controls.providers`
      JSON column.

      **Home → Providers card (student):** one row per provider
      the instructor allows. Three states — ✅ "Connected as
      `<account>`" (student creds in use), ◌ "Using class pool"
      (instructor fallback active), ⚠ "Not connected" (pool
      fallback off; student must connect to use). "Connect" / "Use
      my own key" CTA opens a per-provider modal — paste API key
      for OpenAI, paste API key OR Claude Code OAuth token for
      Anthropic, Local is auto-detected. Disconnect button on
      connected state. Mirrors the existing Telegram / Google card
      pattern.

      **Models tab (passive indicator):** each provider section
      gets a status pill in the header reflecting which credential
      path is active. Provider section appears iff `allow=true` AND
      (student has own creds OR `pool_fallback=true`). Otherwise
      the section is hidden or shown with a "Connect on Home" CTA.

      **Resolver (`credential-proxy.ts`):** extended to consult
      `data/student-provider-creds/<sanitized_user_id>/<provider>.json`
      ahead of `.env`, with the agent's user_id resolved via the
      existing `classroom_roster` lookup. Pseudocode:
      `try student-creds → if absent AND class_controls.pool_fallback[provider] → use .env → else return 402-style envelope`.
      Per-call attribution surfaces the principal (`"student:<id>"`,
      `"class-pool"`, or `"unauthorized"`) so usage aggregation
      stays clean.

      **What this generalizes:** Phase 14 hardcoded the fallback
      policy per-tool (Drive fallback always on, Gmail/Calendar off).
      X.7 makes it instructor-toggleable per-provider. Backporting
      to Google is scope creep — leave Phase 14 as-is.

      **Out of scope for X.7:** time-bounded grants (the old
      "temp-password" idea — `ncl temp-creds grant --hours 24`)
      can be added later as a refinement of the fallback toggle
      with an optional TTL. Not in v1.

      **Phase 14 asymmetry (follow-up):** `src/student-google-auth.ts`,
      `src/channels/playground/api/google-auth.ts`, and the Home/Models
      UI patches for Google currently live in trunk. X.7's classroom-
      branch split exposes this asymmetry; the clean state would
      migrate Phase 14 to `origin/classroom-x7-provider-auth` and install via
      `/add-classroom-google-auth`. Not blocking, tracked separately.

      Detail: [`plans/credential-proxy-per-call-attribution.md` §X.7](../../../plans/credential-proxy-per-call-attribution.md)
- [ ] **gws-mcp Phase 13.5b — Calendar list/create.** Earns its
      keep once each user has their own calendar. Skipped in
      shared-classroom mode where everyone shares one workspace
      calendar.
      Detail: [`plans/gws-mcp-v2.md` §13.5b](../../../plans/gws-mcp-v2.md)
- [ ] **gws-mcp Phase 13.5c — Drive listing.** Safe to expose once
      per-person mode lands — Google's own auth scopes the result
      to the authenticated user, no per-call ownership filtering
      needed.
      Detail: [`plans/gws-mcp-v2.md` §13.5c](../../../plans/gws-mcp-v2.md)
- [ ] **gws-mcp Phase 13.5d — Gmail search/send.** Same reasoning.
      Detail: [`plans/gws-mcp-v2.md` §13.5d](../../../plans/gws-mcp-v2.md)
- [ ] **classroom Phase 4 — provider settings panel.** Homepage UI
      for students to manage their own provider OAuth + GWS OAuth
      + temp-code redemption. Depends on Phase 14 + X.7.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 4](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 5 — agent export tooling.** Four formats:
      `nanoclaw` / `claude-code` / `codex` / `json`. Endpoint:
      `GET /api/draft/<folder>/export?format=…`.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 5](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 6 — home tab redesign.** Today's home tab
      is a uniform grid of eight same-weight cards (Profile, Class
      controls, Students, Settings, Telegram, Google, API credits,
      Session, Help) — functional but not inviting. Needs a real
      brainstorming pass before it gets a phased plan; this bullet
      is a placeholder so the work is queued and named. Observed
      pains:

      - Greeting uses the platform user id (`playground:tjabrah@…`)
        instead of the student's display name from the roster.
      - The raccoon-unicycle personality from the chat tab doesn't
        carry through — no hero, no warmth, just admin chrome.
      - The two "do this" cards (Connect Telegram, Connect Google)
        are buried mid-grid at the same visual weight as reference
        info (session timestamp, sign-in identity).
      - The Help card — which actually explains *what the playground
        is for* — sits at the bottom where nobody reads it.
      - Logout buttons get a top-level card slot equal to Profile;
        belongs in a profile menu in the topbar.
      - Student view feels sparse (Class controls / Students hidden;
        the remaining cards don't fill the grid).
      - API credits card opens with a dense table; fine for
        instructor, intimidating-and-irrelevant for a student who
        doesn't pay for tokens.

      Proposed direction for the brainstorm (not committed):
      - Hero band: "Welcome, <display-name>" + raccoon-unicycle +
        one-sentence framing of what the playground is, with a
        prominent **Open chat** primary CTA.
      - Differentiated card tiers — actions (Connect Telegram /
        Google) lifted with brand accent; status cards (Profile,
        Session) muted; reference cards (API credits) collapsed by
        default for students.
      - Per-role layouts: student sees actions + chat-shortcut +
        what-can-I-do tips; instructor sees Class controls +
        Students roster + cost rollup first.
      - Display-name resolution from `classroom_roster.display_name`
        (already on disk) instead of platform id.
      - Move logout to a profile dropdown anchored in the topbar.

      Slot before Phase 7 because expert-system / RAG strategies
      are likely to surface their own home-tab UI (strategy picker,
      eval results), and we want a clean canvas to build on rather
      than retrofitting around it. No backend changes beyond a
      display-name lookup and possibly a "tagline" / agent-blurb
      field. **Detailed brainstorm → spec → plan deferred** —
      revisit when Phase 14 GCP is unblocked and student-side UI is
      live so we can prioritize from real friction.

      **Coupling with X.7:** the home-tab redesign needs to host
      X.7's Providers card alongside Telegram and Google. Phase 6
      should be designed with that subsection in mind so we don't
      retrofit. If X.7 ships first (the current order), Phase 6
      inherits a known-shape Providers card and just refines the
      surrounding hierarchy.

- [ ] **classroom Phase 7 — expert system builder + RAG
      strategies.** Pipeline framework + named strategies + UI.
      Cost-economical only after Phase 1 #8 (local-LLM runbook)
      lands.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 7](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 8 — evaluation framework.** Side-by-side
      strategy comparison + LLM-as-judge mode. Depends on Phase 7
      (nothing to evaluate without strategies). The Phase-1.5
      per-call trace events are a precondition — the evaluation
      needs per-call cost breakdowns.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 8](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 9 — walk-away cloud deploy.** Bundle +
      bootstrap script. Depends on Phase 5 (export) for the
      bundle format.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 9](../../../plans/classroom-web-multiuser.md)

---

## Success criteria

(Same as `plans/master.md` §"Phase 2 success criteria".)

- Student completes own Google OAuth → agent operates as them
  against their own Drive.
- Student opts into per-person provider OAuth; if not, LLM access
  stops gracefully at temp-code expiry.
- Instructor exports an agent in any of four formats and
  re-imports it cleanly.
- A RAG strategy lab runs end-to-end with side-by-side evaluation.
- A class can be bundled and walked away with — one bootstrap
  script on a fresh VPS reproduces the working state.

---

## Execution notes

- Each unchecked slice is its own commit (or small commit cluster)
  with its own test suite — open the sub-plan link above for the
  actual TDD steps.
- The Phase-1.5 trace + catalog + Claude work was discovered
  + shipped DURING the live class, not pre-planned. Captured here
  so the chain of preconditions for Phase 2 #8/9 is explicit.
- Sub-plans MAY have changed since they were last reviewed; if a
  slice doesn't match its sub-plan when you open it, the sub-plan
  is the source of truth — not the bullet here.
