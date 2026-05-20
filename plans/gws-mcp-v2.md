# Phase 13.5 — Google Workspace MCP V2 tool surface

V1 (Phases 13.2–13.4) shipped two tools that close the rclone gap for
Google **Docs**:

- `drive_doc_read_as_markdown`
- `drive_doc_write_from_markdown`

V2 expands the surface to Sheets, Calendar, Drive listing, and (with
careful scoping) Gmail. Each cluster is a **separate sub-phase**, only
landed when a concrete use case shows up. This file is the shared
design doc the per-sub-phase plans will reference, so the four
clusters stay consistent on auth, scoping, error shape, and test
pattern.

## Why a shared plan

Three things tend to drift across multiple-tool feature work:

1. **Argument shape conventions** — `file_id` vs `fileId`, optional
   create flags, what counts as a "name." V1 settled on snake_case in
   the host validators (`file_id`, `create_if_missing`) with the
   container shim passing through unchanged. V2 inherits that.
2. **Role enforcement** — every tool needs a row in the role matrix
   below, decided once rather than re-litigated per PR.
3. **Test pattern** — V1 established host-side `vitest` tests that
   mock `@googleapis/*` clients + bun:test container shims that mock
   `fetch`. New tools follow the same two-layer pattern.

The infra carries forward unchanged: host `gws-mcp-tools.ts` →
`gws-mcp-server.ts` dispatch → `gws-mcp-relay.ts` HTTP →
`X_NANOCLAW_AGENT_GROUP` attribution → `getGoogleAccessTokenForAgentGroup`
→ per-student or instructor token. Each sub-phase only adds tool
functions + their registry entries.

**One infra prerequisite** lands before the first V2 tool: extend
`getGoogleAccessTokenForAgentGroup` to return `{ token, principal }`
where `principal` is `'self' | 'instructor-fallback'`. The current
function returns just the token, so callers can't tell whether the
caller's own credentials were used or the instructor's. Every V2 tool
needs that distinction to enforce the mode-2 refusals below — and
even mode-3 callers can use it for clearer error messages ("you
haven't completed /gauth yet"). Implementation: trivial; the function
already branches internally on per-student token presence.

## OAuth scopes

`DEFAULT_GWS_SCOPES` in `src/gws-auth.ts` already covers everything
V2 will touch:

| Scope                                            | Used by V2 sub-phase            |
|--------------------------------------------------|---------------------------------|
| `https://www.googleapis.com/auth/spreadsheets`   | 13.5a (sheets)                  |
| `https://www.googleapis.com/auth/calendar`       | 13.5b (calendar)                |
| `https://www.googleapis.com/auth/drive`          | 13.5c (drive listing — already used by 13.2/13.4) |
| `https://www.googleapis.com/auth/gmail.modify`   | 13.5d (gmail)                   |

No re-consent needed when V2 lands — instructor and per-student tokens
both already carry these scopes. Cuts the rollout cost to "ship code,
nothing else."

## Three deployment modes

V2 supports three deployment shapes. per-person mode is the highest-fidelity
boundary model; shared-classroom mode is the simplest setup that's still safe enough
for low-stakes classroom use; Mode 1 is the single-user install.

**Mode 1 — single instructor / non-class install.** One GWS account,
one user, no roles. Every call resolves the host's single OAuth
bearer. The role matrix collapses to "all" everywhere. No ownership
checks needed.

**Shared-classroom mode — class install with shared workspace.** One class GWS
account; everyone (instructor + students) operates under that single
OAuth bearer. **No expectation of Google-level privacy** — Drive is
effectively a public folder for the class. Friction comes from
NanoClaw's own ownership primitive (Phase 13.6): every doc/event we
create is tagged with `nanoclaw_owners`; writes/deletes on docs the
caller doesn't own hard-block at the tool layer. Setup is one OAuth
dance for the workspace, then student web logins via personal email
work against shared docs (anyone-with-link). Single point of failure:
class account lockout = whole class down. Documented operational
risk; no code fix.

**Per-person mode — per-person personal accounts.** Each user authorizes their
own personal Google account via magic-link OAuth (Phase 14).
`getGoogleAccessTokenForAgentGroup` resolves per-user tokens.
Boundaries are Google's own — a student token literally can't see the
instructor's Drive. Setup heavier (per-student OAuth flow), but
boundaries are bulletproof and the ownership primitive is redundant.

**Mode detection.** The relay asks
`getGoogleAccessTokenForAgentGroup(agentGroupId)` for a token and
either gets a per-user token (per-person mode) or the workspace fallback
(shared-classroom mode / Mode 1). The `principal` return value (`'self' |
'instructor-fallback'`) tells the tool which world it's in. In shared-classroom mode,
the tool runs the ownership-tag check before mutating. In per-person mode, the
tag check is skipped — Google already enforces.

## Role matrix (assumes per-person mode)

Each tool is gated by `canAccessAgentGroup` (already enforced in
`gws-mcp-relay.ts`). The matrix below specifies what each role can do
*through the relay's resolved OAuth bearer*, **assuming per-person mode**. In
Mode 1 every cell collapses to "all" (one principal). In shared-classroom mode, the
caller has the workspace bearer (effectively "all" from Google's
view), but the ownership tag check from Phase 13.6 gates writes —
read everything, write only what `nanoclaw_owners` permits.

| Tool                          | Student     | TA          | Instructor | Non-class agent |
|-------------------------------|-------------|-------------|------------|-----------------|
| `sheet_read_range`            | own files   | class files | all        | all             |
| `sheet_write_range`           | own files   | class files | all        | all             |
| `calendar_create_event`       | own cal     | own + class | all        | all             |
| `calendar_list_events`        | own cal     | own + class | all        | all             |
| `drive_list_files`            | own scope   | class scope | all        | all             |
| `gmail_search`                | own inbox   | own inbox   | all        | all             |
| `gmail_send`                  | **blocked** | **blocked** | own only   | own only        |

`gmail_send` deliberately stays blocked for students/TAs even after
Phase 14, because impersonation risk outweighs the niche utility. Open
explicitly if a real instructor-approved workflow emerges.

## Per-sub-phase plan

### 13.5a — Sheets read + write

**Trigger to start:** a class needs a gradebook, attendance, or
structured-data collection workflow that students or TAs must update
programmatically.

**Mode stance.** Mode 1: works. shared-classroom mode: reads are open (workspace
shared by design); writes gated by `nanoclaw_owners` tag from
Phase 13.6 — students can only write to sheets they own / co-own.
per-person mode: Google native — own sheets only unless explicitly shared.

- New dep: `@googleapis/sheets` (per-API package; check release age
  policy on the host).
- `src/gws-mcp-tools.ts` — add `sheetReadRange`, `sheetWriteRange`.
  Read returns `{ ok: true, spreadsheetId, range, rows: string[][], cells: number }`.
  Write takes `{ spreadsheet_id, range, values: string[][], value_input_option?: 'RAW'|'USER_ENTERED' }`
  and returns `{ ok: true, spreadsheetId, range, updatedCells: number }`.
- `src/gws-mcp-server.ts` — register both. Validators check `spreadsheet_id` + `range` shape (A1 notation).
- `container/agent-runner/src/mcp-tools/gws.ts` — two new shims using
  the existing `callRelay` helper. Export both for tests.
- `container/agent-runner/src/mcp-tools/gws.test.ts` — extend with 4
  cases (read success, read error, write success, write w/ value_input_option).
- `src/gws-mcp-server.test.ts` — extend `listToolNames` expectation;
  add per-validator unit tests.

### 13.5b — Calendar list + create

**Trigger to start:** office hours, deadlines, or class-schedule
workflows.

**Mode stance — defer to Phase 2 (per-person mode).** Calendar in shared-classroom mode
collapses to one shared class calendar; the friction model boils
down to "instructor manages it" which doesn't need agent tooling.
Per-person calendars (per-person mode) are where these tools earn their
keep — students invite each other to office hours, students see
their own deadlines, etc. Pushed out of Phase 1 because the value
isn't there yet.

Mode 1: works (instructor's own primary). shared-classroom mode: shared class
calendar — friction collapses; deferred. per-person mode: each user has
their own primary calendar; Google native boundaries.

- New dep: `@googleapis/calendar`.
- Tools:
  - `calendar_list_events({ calendar_id?, time_min?, time_max?, q?, max_results? })`
    → `{ ok: true, events: Array<{ id, summary, start, end, attendees? }> }`.
    `calendar_id` defaults to `primary` of the resolved auth principal.
  - `calendar_create_event({ calendar_id?, summary, start, end, attendees?, description?, location? })`
    → `{ ok: true, eventId, htmlLink }`.
- Stamping invites onto students' own calendars (Phase 14 dependent)
  is the main reason these are useful. Pre-14, instructor's calendar
  only — explicitly documented.
- Same dual-layer tests as 13.5a.

### 13.5c — Drive listing

**Trigger to start:** agents need to discover what's in their Drive
scope (rclone view stale or filter-heavy queries don't translate
cleanly to a filesystem walk).

**Mode stance.** Mode 1: lists everything. shared-classroom mode: **don't expose to
non-instructor agents.** The point of shared-classroom mode is "students only have
the links they're given" — handing them a search tool defeats that
explicitly. Boundary by tool surface, not by query rewriting. per-person mode:
Google native — each user lists their own Drive.

- No new dep (already on `@googleapis/drive`).
- Tool: `drive_list_files({ q?, page_size?, page_token?, fields? })`
  → `{ ok: true, files: Array<{ id, name, mimeType, modifiedTime, parents? }>, nextPageToken? }`.
- Role scoping in `gws-mcp-tools.ts`: when the resolved principal is a
  student or TA, automatically AND the user-supplied `q` with a parent-
  folder constraint resolved from the classroom roster. (`canAccessAgentGroup`
  already gates the call; this enforces *what the call sees*.)
- Test note: golden test for the q-mutation logic in particular,
  because that's the security boundary.

### 13.5d — Gmail (instructor-only V2)

**Trigger to start:** instructor needs the agent to draft+send emails
on their behalf (e.g., "email the parents of students with overdue
assignments").

**Mode stance.** All three modes: `gmail_send` blocked for student/TA
callers. shared-classroom mode: also block `gmail_search` for non-instructor agents
(class workspace inbox is shared with the workspace admin; students
shouldn't browse it). per-person mode: `gmail_search` allowed against own
inbox; `gmail_send` still blocked.

- New dep: `@googleapis/gmail`.
- Tools:
  - `gmail_search({ q, max_results? })` →
    `{ ok: true, messages: Array<{ id, threadId, snippet, from, to, subject, date }> }`.
  - `gmail_send({ to, subject, body, cc?, bcc?, reply_to_message_id? })`
    → `{ ok: true, messageId, threadId }`.
- Relay-level guard: both tools refuse if the resolved role is
  `student` or `ta`. This is a stronger guard than `canAccessAgentGroup`
  because even a non-class scoped admin shouldn't auto-send mail on
  someone else's behalf without a clear approval flow.
- `gmail_send` deliberately has no draft/preview step in V2 — if the
  call goes through, the email goes out. Adding a "draft + approve"
  flow is a Phase 15+ idea, tracked separately when use case appears.

### 13.5e — Slides

**Trigger to start:** a lab or assignment needs students (or the
instructor agent) to create / edit Google Slides decks
programmatically.

**Mode stance.** Mode 1: works. shared-classroom mode: reads open, writes/deletes
gated by `nanoclaw_owners` (Slides are Drive files — same tag
mechanism as Docs). per-person mode: Google native.

- New dep: `@googleapis/slides`.
- Tools:
  - `slides_create_deck({ title?, parent_folder_id? })` → create new
    Slides presentation. Sets `nanoclaw_owners` + anyone-with-link
    sharing on create.
    Returns `{ ok: true, presentationId, webViewLink }`.
  - `slides_append_slide({ presentation_id, layout? })` → add a new
    slide at the end. `layout` defaults to `BLANK`; other valid
    values pass through to the Slides API.
    Returns `{ ok: true, slideId, position }`.
  - `slides_replace_text({ presentation_id, find, replace_with })`
    — find/replace across the deck (Slides API has a native batch
    `replaceAllText`). Returns `{ ok: true, occurrencesChanged }`.
- Same dual-layer tests as 13.5a.

## Open questions (decide at sub-phase start, not now)

- **Pagination defaults.** `drive_list_files` and `gmail_search` are
  the only paginating tools. Default `page_size` of 50 or 100? Stop
  iterating on caller side or include nextPageToken transparently?
- **Time-range parsing for calendar.** Accept ISO-8601 strings only,
  or also natural-language ("today", "next monday") via a tiny
  helper? V1 of every tool prefers strict ISO; helpers can come later.
- **Empty `values` writes for sheets.** Drive treats an empty write as
  a clear. Decide: error out, or pass through? Probably error — agents
  asking for "clear range X" should use a different tool name.
- **Per-tool dry-run flag.** Useful for gmail_send specifically; not
  for the others. Defer.

## Non-goals for V2

- **Bulk operations.** No batch APIs. Agents loop in their own time.
- **Watch / push notifications.** Drive/Gmail push subscriptions are
  out — adds host-side endpoints we don't need yet.
- **Editing Calendar events** (`calendar_update_event` /
  `calendar_delete_event`). Add only with a real cleanup workflow
  driving them.
- **Drive folder creation.** `class-drive.ts` already does this for
  the classroom path; expose as a tool only if a non-classroom
  workflow needs it.

## Acceptance criteria for the whole phase

13.5 isn't "done" — it's a parent phase under which 13.5a / 13.5b /
13.5c / 13.5d / 13.5e each ship independently. The parent is done
when each sub-phase is either landed or explicitly closed-as-not-needed.

**Mapping to master-plan phases:**

- **Phase 1 (shared-classroom MVP):** 13.5a (Sheets) + 13.5e (Slides).
  Both reuse 13.6's Drive ownership tag — they're Drive files, no
  new ownership infrastructure needed.
- **Phase 2 (per-person mode, per-person GWS):** 13.5b (Calendar) + 13.5c
  (Drive listing) + 13.5d (Gmail). All three earn their utility from
  per-person accounts: calendar makes sense when each user has their
  own; drive listing scopes naturally to a user's own Drive; gmail
  send-as-self is the only safe mode. Don't ship until Phase 14 lands.

## Substeps

#### 13.5.0 — Plan ✅ (this file)

#### 13.5a — Sheets read/write

#### 13.5b — Calendar list/create

#### 13.5c — Drive listing

#### 13.5d — Gmail (instructor-only)

#### 13.5e — Slides create/append/replace-text
