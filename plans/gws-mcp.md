# Phase 13 — Host-side Google Workspace MCP

A thin Node MCP server, host-side, that exposes a curated set of
Google Workspace operations to NanoClaw agents. Each agent's session
gets a stub MCP entry pointing at this server (via the credential
proxy) so the OAuth refresh token never leaves the host.

This phase fills the gap rclone leaves: rclone makes Drive *files*
look like a normal filesystem (great for bash + Read/Write), but it
can't do Google-application operations — Doc text editing, Sheet
range read/write, Calendar event creation, Gmail send. Phase 13
covers those.

## Why custom Node MCP, not the alternatives

Three alternatives considered + rejected:

- **`@googleworkspace/cli` shelled out as MCP backend.** Adds
  subprocess overhead per call; CLI's flag surface limits what we
  can expose; no benefit over calling the Google APIs directly.
- **Monolith `googleapis` npm package.** Drags the VPS at install
  time (250+ auto-generated API clients + types). Already crashed
  this user's host once.
- **Community Python MCP** (`taylorwilsdon/google_workspace_mcp`).
  Works, but adds a Python runtime and we don't control the
  surface. Acceptable if we want to ship-now without writing code.

**Chosen**: per-API npm packages — `@googleapis/docs`,
`@googleapis/drive`, `@googleapis/sheets`, `@googleapis/calendar`,
`@googleapis/gmail`. Each is small (<2MB), Google-published, and we
write a thin wrapper that exposes only the tools we need.

## Auth model

Reuses `~/.config/gws/credentials.json` (the OAuth refresh token
already minted by the original taylorwilsdon-MCP install). No new
OAuth dance. The same trust model as our existing `class-drive.ts`:

- The refresh token never enters any container.
- The MCP runs on the host with that token.
- Agents call into the MCP via a stub registered in their
  `container.json` `mcpServers`.
- The credential proxy / a dedicated MCP relay forwards the agent's
  JSON-RPC to the host MCP, authenticates the caller by agent
  group ID, applies role-based filters, and returns the result.

## Per-agent scoping (the security boundary)

The proxy authenticates the caller by agent group ID (same
mechanism as Phase 9's per-student Codex auth — structured
placeholder env vars at spawn). The host MCP then enforces role
boundaries:

- **Student** (member of own `student_NN` only): Doc
  read/write within their own Drive folder; calendar of their own
  account if scope allows; **no Gmail send** (or scoped to their
  account only — instructor decides at install).
- **TA** (scoped admin on every student/ta): Doc read/write
  across all class Drive folders; same Calendar rules as students.
- **Instructor** (global admin): full access.
- **Non-class agent groups** (default install): full access — same
  as the host's own OAuth scope.

The proxy looks up the caller's role via the existing
`canAccessAgentGroup` primitive (Phase 12.6 already exposed userId
to gates; same lookup pattern reused here).

## V1 surface (Phase 13.1)

Two tools — exactly what rclone can't do:

- **`drive_doc_read_as_markdown(file_id_or_path)`** — fetches a
  Google Doc, exports as markdown via the Drive `export` endpoint
  (`text/markdown` MIME). Returns the markdown string.
- **`drive_doc_write_from_markdown(file_id_or_path, markdown)`** —
  uploads markdown as a new Google Doc (or replaces an existing
  one), via the Docs API.

Argument shape supports either a Drive file ID or a path within
the agent's accessible Drive folder. Path resolution uses
`@googleapis/drive`'s file search.

These two close the rclone gap completely for class students who
need to read/write course Docs.

## V2 expansions (Phase 13.2+, gated by need)

Each is a separate sub-phase, added only when an actual use case
shows up. Rough order of likely value:

- **`sheet_read_range`** + **`sheet_write_range`** — gradebooks,
  attendance, structured data students collect.
- **`calendar_create_event`** + **`calendar_list_events`** —
  office hours, class schedule, deadlines.
- **`drive_list_files`** with role-scoped folder filter — for cases
  where rclone's view is stale (class just shared a new file and
  rclone hasn't polled yet).
- **`gmail_search`** + **`gmail_send`** — niche; needs careful
  scoping (student-as-themselves, not as instructor).

## Implementation outline

### Files

- `src/gws-mcp-server.ts` — host-side MCP server. Listens on
  loopback, accepts JSON-RPC requests, dispatches to tool handlers.
- `src/gws-mcp-tools.ts` — per-tool implementations. One function
  per exposed tool. Each is ~30 lines: build the API call, invoke
  the right `@googleapis/*` client, format the response.
- `src/gws-mcp-relay.ts` — sits in front of `gws-mcp-server.ts`.
  Authenticates the calling agent group, applies the role filter,
  forwards to the server. Same pattern as the credential proxy.
- `container/agent-runner/src/mcp-tools/gws-stub.ts` — stub MCP the
  agent registers locally; forwards stdio JSON-RPC to the host
  relay over loopback. Mirrors `add-gmail-tool`'s stub pattern but
  goes to our credential proxy instead of OneCLI.
- New deps in `package.json`: `@googleapis/docs`, `@googleapis/drive`.
  Add other per-API packages incrementally.

### Wiring

- Agent group's `container.json` `mcpServers` entry is added by an
  installation skill (Phase 13.4). Format mirrors how channel
  skills wire themselves (e.g., `add-gchat`).
- Per-agent role lookup happens in the relay via the existing
  `canAccessAgentGroup` (no new permission primitive needed).
- Auth refresh: the OAuth refresh token in `~/.config/gws/credentials.json`
  is read at MCP startup and used to mint short-lived access tokens
  on demand. Refresh token rotates if Google rotates it (write back
  to the file). Same mechanism the original taylorwilsdon-MCP used.

### Skills

Phase 13 ships as **one** install skill, `/add-gws-tool` (or
similar). Replaces the deleted `/add-gmail-tool` and `/add-gcal-tool`
skills — same idea (Google MCP for the agent), different mechanism
(native credential proxy, our own MCP rather than OneCLI-managed
gongrzhe/cocal MCPs).

## Substeps

#### 13.0 — Plan ✅

#### 13.1 — Clean up OneCLI-only skills ✅
- [x] Delete `.claude/skills/add-gmail-tool/` (removed in 8f5f040).
- [x] Delete `.claude/skills/add-gcal-tool/` (removed in 8f5f040).

These don't work on this install (require OneCLI gateway). Phase
13's `/add-gws-tool` supersedes them.

#### 13.2 — Host-side MCP server (V1: Doc read/write) ✅
- [x] `src/gws-mcp-server.ts` — minimal MCP over JSON-RPC.
- [x] `src/gws-mcp-tools.ts` — `drive_doc_read_as_markdown`,
      `drive_doc_write_from_markdown`. Use `@googleapis/drive` and
      `@googleapis/docs`.
- [x] OAuth client setup in `src/gws-auth.ts` — reads
      `~/.config/gws/credentials.json`, exchanges refresh for
      access token, refreshes on 401.

#### 13.3 — Per-agent relay ✅
- [x] `src/gws-mcp-relay.ts` — JSON-RPC pass-through with role
      check via `canAccessAgentGroup`.
- [x] Reuses the credential proxy's per-container placeholder
      pattern to identify the caller.

#### 13.4 — Container → relay wiring + install skill ✅

Originally framed as "stub MCP that forwards to the host relay." In
practice the container already has an inline `gws.ts` registered via
`registerTools()` (global, every agent), reaching the credential
proxy's `/googleapis/*` pass-through at port 3001. That works but
bypasses the per-agent role boundary the relay enforces.

So 13.4 is a refactor, not a new stub file: point `gws.ts` at the
Phase 13.3 relay (port 3007) so role checks via `canAccessAgentGroup`
actually fire on every tool call. The per-agent attribution header
(`X-NanoClaw-Agent-Group`) is already set on every container by the
recent `feat/credential-proxy-attribution` work — we just have to
include the relay's origin in the set of "proxy-bound" hosts.

- [x] `src/container-runner.ts` — add `GWS_MCP_RELAY_URL=http://<gateway>:GWS_MCP_RELAY_PORT`
      env at spawn; drop the now-unused `GWS_BASE_URL` (gws.ts was the
      only consumer; proxy-fetch falls back to `ANTHROPIC_BASE_URL`).
- [x] `container/agent-runner/src/mcp-tools/gws.ts` — rewrite both
      handlers to `POST ${GWS_MCP_RELAY_URL}/tools/<name>`, JSON body =
      args, header `X-NanoClaw-Agent-Group` set explicitly from
      `X_NANOCLAW_AGENT_GROUP`. Mirror host's write surface (file_id
      required; create_if_missing/parent_folder_id/name optional).
- [x] `container/agent-runner/src/proxy-fetch.ts` + `.test.ts` — drop
      the now-stale `GWS_BASE_URL` reference; relay's port-3007 attribution
      is set explicitly by `gws.ts` so it doesn't need to live in the
      monkey-patched fetch's match set.
- [x] `container/agent-runner/src/mcp-tools/gws.test.ts` — new bun:test
      file. Mock fetch, verify path/header/body and that `ok:false` is
      surfaced as MCP `isError: true`.
- [x] `.claude/skills/add-gws-tool/SKILL.md` — verify
      `~/.config/gws/credentials.json` exists, smoke-test the relay
      with `curl /tools`. Convention in this tree is single SKILL.md
      (no separate REMOVE.md / VERIFY.md); uninstall + verify steps
      are inline. Defers OAuth bootstrap to manual or the future
      `scripts/gws-authorize.ts` (still pending — see Phase 14).

#### 13.5 — V2 tool surface (separate plan)

Detailed sub-plan: [plans/gws-mcp-v2.md](gws-mcp-v2.md). Splits V2 into
five sub-phases (sheets, calendar, drive-listing, gmail, slides), each
gated on a real use case. Sheets (13.5a) is the suggested first
landing target when a classroom gradebook need appears.

#### 13.6 — shared-classroom mode ownership primitive (unblocks shared-workspace mode) ✅

V1 + V2 tools assume Google's own permissions are the boundary. For
**Shared-classroom mode** — one shared class-workspace OAuth account, students
operate under it, no privacy expectation but real friction expected
when one student touches another's work — Google can't help us: every
file is owned by the same workspace account. We tag NanoClaw ownership
as Drive `customProperties` (and Calendar `extendedProperties.private`)
and enforce friction at the tool layer.

**Schema.** Single property `nanoclaw_owners` on every NanoClaw-created
file / event. Value is a comma-separated list of agent_group_ids, e.g.
`ag_42,ag_77`. First entry is the original creator; the list grows when
existing owners grant to others. Lifecycle:

- **Create** → set `nanoclaw_owners = [caller_agent_group_id]`. Apply
  `anyone-with-link can edit` share so students can open through their
  personal-email web login.
- **Write/edit** → read `nanoclaw_owners`; if absent, **claim-on-first-touch**
  (set to `[caller]`, proceed); if present and caller not listed,
  **hard block** with a human-readable error including the owners'
  display names (looked up from `agent_groups.display_name`).
- **Delete** → same check as write. Hard block if not in list.
- **Grant/revoke ownership** → three new tools below; require caller to
  be in current `nanoclaw_owners`.

**New tools (all roles):**

- `drive_doc_grant_ownership({ file_id, agent_group_id })` — add an
  agent group to `nanoclaw_owners`.
- `drive_doc_revoke_ownership({ file_id, agent_group_id })` — remove
  one. Caller can't revoke itself if it's the last owner (would leave
  the file unowned).
- `drive_doc_list_owners({ file_id })` — return the list with
  display_name resolution.

Calendar gets the same trio (`calendar_event_grant_ownership`, etc.)
mirroring the schema on `extendedProperties.private.nanoclaw_owners`.
Sheets and Slides ride on Drive's `customProperties` — same tools work.

**Substeps:**

- [x] `src/gws-ownership.ts` (extracted from gws-mcp-tools for reuse) — add `readDriveOwners(fileId)`,
      `claimOrCheckDriveOwnership(fileId, callerAgentGroupId)`,
      `writeDriveOwners`, `stampNewDriveFile`, `formatHardBlockMessage`
      helpers. Wire `driveDocWriteFromMarkdown` through the check;
      on create, set initial `customProperties` + `anyone-with-link`
      share via `drive.permissions.create`.
- [x] `src/gws-mcp-tools.ts` — add `driveGrantOwnership`,
      `driveRevokeOwnership`, `driveListOwners`. Each resolves
      display names from `agent_groups` table for the error/list
      response.
- [x] `src/gws-mcp-server.ts` — register the three new tools in the
      `TOOL_REGISTRY`. Validators accept `file_id` + `agent_group_id`.
- [x] `src/gws-mcp-server.test.ts` — extend `listToolNames` expectations;
      add dispatch unit tests for the three new tools.
- [x] `container/agent-runner/src/mcp-tools/gws.ts` — three new shims
      mirroring the host signature. Export each for tests.
- [x] `container/agent-runner/src/mcp-tools/gws.test.ts` — add cases
      for grant/revoke/list + a "hard block" case verifying the
      error text includes a display name (not just an ID).
- [x] Operational note in `.claude/skills/add-gws-tool/SKILL.md`
      — flag the single-point-of-failure caveat for shared-classroom mode, plus
      per-account API quota + polite-enforcement-not-secure notes.

## Out of scope (V1)

- Gmail send-as-instructor for students. Too easy to abuse;
  requires explicit role allowlist before V2.

## Phase 14 — Per-student Google OAuth (required before class deploy)

The V1 architecture above routes EVERY agent's GWS calls through the
instructor's OAuth bearer. For a single-instructor deployment that's
fine. For class use it's a real boundary problem: a student's agent
calling `drive_doc_read_as_markdown(fileId)` could read any Doc the
instructor has access to, not just their own. URL-pattern gating at
the proxy partially helps but is brittle (fileId-to-folder lookups,
per-call auth checks) and a parsing bug = full breach.

**Right shape: per-student OAuth, mirroring Phase 9's Codex auth pattern.**

- Students click a magic link, authorize Google with their own school
  account, the OAuth refresh token lands at
  `data/student-google-auth/<sanitized_user_id>/credentials.json`.
- Proxy looks up *which student* is calling (existing per-container
  env scheme from Phase 9.3), uses *that student's* refresh token
  for the API call.
- Student's agent literally operates as them. Reads their own Drive
  only. Boundary enforced by Google's auth, not by URL parsing.
- Instructor's OAuth still used host-side at pair time (creating +
  sharing the student's folder via `class-drive.ts`) — that's
  separate from runtime agent calls.

**Foundation already in place:**

- `src/gws-auth.ts` — pure helpers: load OAuth client, build
  authorization URL, exchange code for tokens, write credentials.json.
  No HTTP server, no CLI. Reusable.
- `scripts/gws-authorize.ts` — one-off CLI that wraps the helpers
  for the instructor to mint a fresh refresh token via localhost
  callback. Dual purpose: solves immediate refresh problems today,
  proves the OAuth exchange before Phase 14 wraps it in a magic-link
  server.

**What Phase 14 adds on top:**

- `src/student-google-auth.ts` — per-student credential storage
  (mirror of `src/student-auth.ts` for Codex auth). Path-sanitized
  user_id → credentials.json on disk.
- Magic-link OAuth flow on the existing student-auth-server (port
  3003 — Phase 9.2). New routes: `/google-auth?t=<token>` redirects
  to Google's consent URL with state encoding the upload token;
  `/google-auth/callback` receives Google's redirect, exchanges the
  code via `gws-auth.ts`, stores per-student credentials.
- Per-student bearer lookup in `src/credential-proxy.ts`. Current
  code reads instructor creds at startup; replace with per-request
  lookup keyed on the calling agent group's `student_user_id`
  metadata. Falls back to instructor creds if no per-student auth
  uploaded yet (graceful migration window).
- New Telegram command `/gauth` → DMs a magic link to the user.
  Mirror of `/login` for Codex auth.
- `class-shared-students.md` instructions point students at `/gauth`.

**OAuth client redirect URIs needed in GCP Console:**

The existing OAuth client (whatever the instructor used originally)
needs `<NANOCLAW_PUBLIC_URL>/google-auth/callback` listed as an
"Authorized redirect URI." One-time GCP Console config, not code.

**Net effect after Phase 14:** running `/add-classroom` +
`/add-classroom-gws` + Phase 13 GWS tools is class-safe. Instructor's
Drive is invisible to students; students authenticate as themselves;
boundaries enforced by Google rather than by our URL parsing.
