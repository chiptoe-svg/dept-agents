# Agent Library — Implementation Plan

> **Design:** [`docs/superpowers/specs/2026-05-21-agent-library-design.md`](../specs/2026-05-21-agent-library-design.md)
> **Master plan:** [`plans/master.md` §Phase 2 #7b](../../../plans/master.md)

**Goal.** Each user gets a personal agent portfolio: Save / Load /
New / Delete named agents. One active at a time. New "Agents" tab in
the playground.

**Files touched:**
- `src/channels/playground/api/agent-library.ts` (new — all library operations)
- `src/channels/playground/api-routes.ts` (register new routes)
- `src/channels/playground/public/app.js` (Agents tab UI)
- `src/channels/playground/public/style.css` (agent card styles)

**Not touched:** `src/router.ts`, session DB schemas, container-runner
(loading just overwrites files + kills container, same path as model switch).

---

## Phase A — Library storage layer

Pure filesystem operations. No HTTP. Importable by the API handlers
and testable in isolation.

- [ ] Create `src/channels/playground/api/agent-library.ts`
- [ ] Define types:
  ```typescript
  interface AgentMeta {
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
  }
  interface LibraryEntry {
    slug: string;
    name: string;
    description: string;
    updatedAt: string;
    isActive: boolean;
    isDirty: boolean;
    provider: string;
    model: string;
    builtinSkills: string[];
    customSkillCount: number;
  }
  ```
- [ ] `libraryRoot(folder: string): string`
  → `path.join(GROUPS_DIR, folder, 'library')`
- [ ] `entryDir(folder, slug): string`
  → `path.join(libraryRoot(folder), slug)`
- [ ] `generateSlug(name: string, existing: string[]): string`
  — lowercase, spaces→hyphens, strip non-alnum-hyphen, max 48 chars,
  append `-2`/`-3` on collision
- [ ] `readActiveSlot(folder): string | null`
  — reads `library/.active-slot` (single line), null if absent
- [ ] `writeActiveSlot(folder, slug): void`
- [ ] `readMeta(folder, slug): AgentMeta | null`
  — reads + parses `library/<slug>/meta.json`; null on any failure
- [ ] `writeMeta(folder, slug, meta: AgentMeta): void`
- [ ] `listLibrary(folder): LibraryEntry[]`
  — reads all subdirs of `library/`, reads meta.json + container.json
  from each, computes `isActive` + `isDirty` (hash CLAUDE.md +
  container.json vs active files), returns sorted by `updatedAt` desc
- [ ] `saveEntry(folder, slug, includeMemory: boolean): void`
  — copies `CLAUDE.md`, `container.json` from group root into
  `library/<slug>/`. Copies `CLAUDE.local.md` only if `includeMemory`.
  Copies `custom-skills/` (full tree) if it exists. Writes `meta.json`
  with current timestamp.
- [ ] `loadEntry(folder, slug): void`
  — copies files from `library/<slug>/` back to group root.
  `CLAUDE.local.md` copied only if present in the entry.
  Replaces `custom-skills/` entirely if entry has it; leaves existing
  `custom-skills/` untouched if entry has none.
  Updates `.active-slot`.
- [ ] `deleteEntry(folder, slug): boolean`
  — removes `library/<slug>/` dir. If slug matches `.active-slot`,
  clears `.active-slot`. Returns false if slug not found.
- [ ] Unit tests:
  - `generateSlug` handles collisions, long names, special chars
  - `saveEntry` then `readMeta` round-trips name + timestamps
  - `loadEntry` overwrites CLAUDE.md; leaves CLAUDE.local.md alone
    when entry has none
  - `loadEntry` with memory: copies CLAUDE.local.md
  - `loadEntry` custom-skills: replaces entirely
  - `loadEntry` no custom-skills in entry: leaves existing intact
  - `deleteEntry` on active slot clears `.active-slot`
  - `listLibrary` empty dir → `[]`; `isDirty` false when content matches

---

## Phase B — Dirty detection

- [ ] `computeFileHash(content: string): string`
  — `crypto.createHash('sha1').update(content).digest('hex')`.
  Small + fast enough for CLAUDE.md + container.json on every list call.
- [ ] `isEntryDirty(folder, slug): boolean`
  — hashes active `CLAUDE.md` + `container.json`; compares to entry's.
  Returns false if entry or active files don't exist.
- [ ] Unit test: returns false for matching content, true after edit

---

## Phase C — API handlers

- [ ] `handleListLibrary(folder, userId)`
  → `canReadDraft` gate → `listLibrary(folder)` → 200 + entries
- [ ] `handleSaveNew(folder, userId, body: { name, description?, includeMemory? })`
  → mutation gate → validate name (non-empty, ≤ 64 chars)
  → check count < 20 (return 409 "Library full" if exceeded)
  → `generateSlug` → `saveEntry` → `writeActiveSlot` → 200 `{ slug }`
- [ ] `handleSaveExisting(folder, userId, slug, body: { includeMemory? })`
  → mutation gate → entry must exist (404 if not)
  → `saveEntry` (overwrites) → update `meta.json.updatedAt`
  → `writeActiveSlot` → 200
- [ ] `handleLoad(folder, userId, slug)`
  → mutation gate → entry must exist → `loadEntry`
  → kill running container (import `killContainer` +
    `isContainerRunning` from `container-runner.ts`)
  → 200
- [ ] `handleRename(folder, userId, slug, body: { name?, description? })`
  → mutation gate → update `meta.json` only → 200
- [ ] `handleDelete(folder, userId, slug)`
  → mutation gate → `deleteEntry` → 200
- [ ] Register all routes in `api-routes.ts`:
  ```
  GET    /api/drafts/:folder/library              → handleListLibrary
  POST   /api/drafts/:folder/library              → handleSaveNew
  POST   /api/drafts/:folder/library/:slug/save   → handleSaveExisting
  POST   /api/drafts/:folder/library/:slug/load   → handleLoad
  PUT    /api/drafts/:folder/library/:slug        → handleRename
  DELETE /api/drafts/:folder/library/:slug        → handleDelete
  ```
- [ ] Integration test: full round-trip with bench session cookie
  — save new, list (1 entry), load, save existing, delete, list (0)

---

## Phase D — Provisioning seed

When a student is provisioned (or on first Agents tab visit), seed
their library with a snapshot of their initial persona so they always
have a revert point.

- [ ] Add `seedInitialLibraryEntry(folder: string): void`
  — checks if `library/` has any entries; if zero, calls
  `saveEntry(folder, 'initial', false)` with meta name = "Initial agent"
  — idempotent (no-op if entries already exist)
- [ ] Call `seedInitialLibraryEntry` from `group-init.ts`
  (the existing per-group scaffold function called at agent creation)
- [ ] Unit test: idempotent — calling twice doesn't create a second entry

---

## Phase E — Default agent templates

Expose `library/default-agents/` as a read-only template catalog.

- [ ] Define template format: each subdirectory is a template with
  `meta.json` + `CLAUDE.md` + optional `container.json` + `custom-skills/`
  (same structure as a library entry)
- [ ] `listDefaultAgents(): LibraryEntry[]`
  — reads `library/default-agents/` (if it exists); returns entries
  sorted by name
- [ ] `GET /api/library/defaults` → `listDefaultAgents()`
  — no auth needed (these are public templates)
- [ ] `POST /api/drafts/:folder/library/from-template`
  Body: `{ templateSlug: string, name: string, description?: string }`
  → mutation gate → reads from `library/default-agents/<templateSlug>/`
  → copies into `library/<newSlug>/` + loads → 200 `{ slug }`
- [ ] Ensure existing `library/default-agents/` content (if any) is
  valid template format; add at least one example entry

---

## Phase F — Agents tab UI

New 5th tab in the playground. Add after Models tab.

- [ ] Add "Agents" tab button to the tab bar in `app.js` + matching
  `#mode-agents` section in the HTML template
- [ ] `renderAgentsTab()` — fetches `GET /api/drafts/:folder/library`
  and renders:
  - Active agent header: name + dirty badge + [Save] [Save As] buttons
  - Agent cards grid (see spec for card content)
  - [+ New Agent] button
  - [Browse templates] button (shows defaults section)
- [ ] Agent card: name, provider/model chip, skills count, active
  indicator (green dot), [Load] [Delete] action buttons
- [ ] "Save" button: if `.activeSlug` set → `POST .../library/:slug/save`.
  If no active slug → fall through to "Save As" flow.
- [ ] "Save As" modal: name input + description input +
  "Include memory snapshot" checkbox (default unchecked) →
  `POST .../library`
- [ ] "New Agent" modal: name input + three starting-point options
  (Blank / Copy current / From template) → on confirm:
  - Blank: `POST .../library` with minimal CLAUDE.md template, then load
  - Copy current: `POST .../library` (snapshot current), then immediate
    `POST .../library/:slug/load` back (no-op content-wise but sets active)
  - From template: `POST .../library/from-template`
- [ ] "Load" confirmation modal: if `isDirty` on active entry, warn
  "You have unsaved changes — load anyway?" with [Load anyway] [Cancel]
- [ ] Templates section: fetch `GET /api/library/defaults`, render as
  cards with [Use this template] button
- [ ] Auto-refresh agents list after Save / Save As / Load / Delete
- [ ] Style: agent cards reuse existing `.model-card` or `.skill-card`
  patterns from `style.css`; add `.agent-card` variant with the
  active indicator dot

---

## Phase G — Wire export to library

Update Phase 5 export so it can target a specific library entry.

- [ ] Add `GET /api/drafts/:folder/library/:slug/export`
  — same as `GET /api/drafts/:folder/export` but reads from
  `library/<slug>/` instead of the group root
  — reuses all Phase 5 bundle generators (pass sources from the
  entry rather than the active group)
- [ ] Add "Export" action to agent cards in the Agents tab UI
  (small button alongside Load/Delete)

---

## Completion criteria

- [ ] Student can save their current agent under a new name
- [ ] Student can load a saved agent; next chat message uses it
- [ ] Loading while dirty warns and requires confirmation
- [ ] Student can create a new agent (blank, copy, or template)
- [ ] Student can rename and delete library entries
- [ ] At 20 entries, New Agent + Save As are disabled with a clear message
- [ ] New agent groups get seeded with one "Initial agent" entry
- [ ] Default templates are browsable and usable
- [ ] Export from a specific library entry works
- [ ] Build clean, existing tests pass
- [ ] Manual end-to-end: create → edit → save → new blank → load original
      — chat history is fresh, persona reflects loaded agent

---

## Estimated effort

| Phase | Time |
|---|---|
| A — Storage layer + tests | ~60 min |
| B — Dirty detection | ~20 min |
| C — API handlers + route registration | ~45 min |
| D — Provisioning seed | ~20 min |
| E — Default templates | ~30 min |
| F — Agents tab UI | ~90 min |
| G — Export from library entry | ~30 min |
| **Total** | **~5 hr** |

Build Phase 5 (export) first — the export machinery (bundle generators,
zip assembly) is reused by Phase G here with minimal additional work.
