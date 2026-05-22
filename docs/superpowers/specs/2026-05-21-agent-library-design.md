# Agent Library — Design

> **Scope:** Each student (or instructor) can maintain a personal
> portfolio of named agents, swap between them, and work on one at a
> time. The playground always runs exactly one "active" agent; the
> library holds saved snapshots the user can return to.
>
> Relates to: Phase 5 (export) — the export API reuses library entries
> as its source. Phase 5b in `plans/master.md`.

## Goal

Today every student has exactly one agent group. They can edit the
persona, skills, and model — but there's no way to save a version,
try something different, and come back. This feature gives each user:

- A named, browsable collection of agent configurations
- Load/activate to swap the running agent
- Save / Save As to preserve their work
- New Agent to start fresh (blank or from a template)
- Delete to clean up

The active agent is always the group folder's current state
(`groups/<folder>/CLAUDE.md`, `container.json`, `custom-skills/`).
The library is a set of named snapshots stored alongside it. Nothing
about routing, sessions, or containers changes — a "load" just
overwrites those files and kills any running container so the next
message starts fresh.

## What an "agent" is

A saved agent entry contains:

| Item | Source |
|---|---|
| `CLAUDE.md` | Persona + instructions |
| `CLAUDE.local.md` | Memory snapshot (optional) |
| `container.json` | Provider, model, skills list, MCP servers |
| `custom-skills/` | Student-created skills (full file tree) |
| `meta.json` | Name, description, timestamps |

Built-in skills are referenced by name in `container.json.skills[]`
and do NOT need to be snapshotted — they're system-global and always
available. Only custom skills (the student's own work) are included
in the snapshot.

## Storage

```
groups/<folder>/
  CLAUDE.md                  ← active agent (what the container sees)
  CLAUDE.local.md
  container.json
  custom-skills/
  library/                   ← NEW
    .active-slot               one line: slug of last loaded/saved entry
    <slug>/
      meta.json              { name, description, createdAt, updatedAt }
      CLAUDE.md
      CLAUDE.local.md        (omitted if empty at save time)
      container.json
      custom-skills/         (full tree — only if student has custom skills)
```

The `.active-slot` file tracks which library entry is currently loaded
so the UI can show which one is active and detect unsaved changes
(current files ≠ active-slot snapshot).

**Slug generation:** `<name>` lowercased, spaces → hyphens, non-alnum
stripped. Collision → append `-2`, `-3`, etc. Max 48 chars.

**Library size cap (V1):** 20 entries per user. Prevents unbounded
disk growth. Instructor can raise via config if needed; for a class
day 5–10 is realistic.

## Default agents (templates)

`library/default-agents/` at the project root contains
instructor-curated agent templates. On first visit to the Agents tab
(or when the library is empty), the UI shows these as "Start from a
template" cards. Selecting one copies it into the user's library and
loads it — the student then owns their copy and can edit freely.

Default agents are read-only at the system level; students never write
back to them.

## API surface

All routes gated by `canReadDraft(folder, userId)` for GET;
mutation gate for write operations (same as all draft mutations).

```
GET    /api/drafts/:folder/library
       → { entries: LibraryEntry[], activeSlug: string | null }

POST   /api/drafts/:folder/library
       Body: { name: string, description?: string, includeMemory?: boolean }
       → { slug: string }        Save current agent as new entry

PUT    /api/drafts/:folder/library/:slug
       Body: { name?, description? }
       → 200                     Rename / update description only
                                  (full content update uses POST + delete old)

POST   /api/drafts/:folder/library/:slug/load
       → 200                     Copy entry → active, kill container,
                                  update .active-slot

POST   /api/drafts/:folder/library/:slug/save
       Body: { includeMemory?: boolean }
       → 200                     Overwrite entry from current active state

DELETE /api/drafts/:folder/library/:slug
       → 200
```

`LibraryEntry`:
```typescript
{
  slug: string;
  name: string;
  description: string;
  updatedAt: string;       // ISO timestamp
  isActive: boolean;       // matches .active-slot
  isDirty: boolean;        // current files differ from this entry
  provider: string;
  model: string;
  builtinSkills: string[];
  customSkillCount: number;
}
```

`isDirty` is computed server-side: compare `CLAUDE.md` + `container.json`
content hashes between active and the active-slot entry. If `.active-slot`
is empty → `isDirty: false` for all entries (no baseline to compare).

`includeMemory` flag on save: `CLAUDE.local.md` can accumulate sensitive
or irrelevant session noise. Default `false` — student opts in if they
want memory snapshotted. This also applies when loading: a loaded entry
WITHOUT `CLAUDE.local.md` leaves the current `CLAUDE.local.md` intact.

## Load behaviour

1. Copy `library/<slug>/CLAUDE.md` → `groups/<folder>/CLAUDE.md`
2. If entry has `CLAUDE.local.md` AND user requested it (or it was
   saved with memory): overwrite `groups/<folder>/CLAUDE.local.md`.
   Otherwise leave existing memory untouched.
3. Copy `library/<slug>/container.json` → `groups/<folder>/container.json`
4. Delete `groups/<folder>/custom-skills/` and replace with
   `library/<slug>/custom-skills/` (if present)
5. Kill any running container for this agent group (same as model switch)
6. Write slug to `.active-slot`

The next message the student sends will start a fresh container with
the loaded agent's configuration.

## New Agent flow

1. Student clicks "New Agent" in the Agents tab
2. Modal: enter a name (required), optional description, choose
   starting point:
   - **Blank** — minimal CLAUDE.md template with just a name placeholder
   - **Copy current** — snapshot of the current active agent
   - **From template** — card picker showing `library/default-agents/`
3. On confirm: create a library entry from the chosen starting point,
   then immediately load it (same as calling `load`)
4. Active agent switches; container respawns on next message

## Dirty state detection

The `isDirty` flag on the active entry tells the student they have
unsaved changes. The UI renders:
- **Active + clean**: green dot on the card
- **Active + dirty**: orange dot + "Unsaved changes" badge on the card
  and near the Save button in the top bar
- **Not active**: no dot

Dirty check compares `CLAUDE.md` + `container.json` only (not
`custom-skills/` — too expensive to hash recursively on every poll).
The Skills tab already has a "file dirty" indicator for custom skill
edits; that's a separate signal.

## UI — Agents tab

New 5th tab in the playground: **Agents**

```
┌─ Chat │ Persona │ Skills │ Models │ Agents ─┐
│                                              │
│  [Active: "Research Assistant"] [Save] [Save As]
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Research │ │ Tutor    │ │ Coder    │    │
│  │ Asst.  ● │ │          │ │          │    │
│  │ sonnet   │ │ haiku    │ │ gpt-5.4  │    │
│  │ 3 skills │ │ 2 skills │ │ 1 custom │    │
│  │ [Load]   │ │ [Load]   │ │ [Load]   │    │
│  │ [Delete] │ │ [Delete] │ │ [Delete] │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
│  [+ New Agent]      [Browse templates →]    │
└──────────────────────────────────────────────┘
```

- Cards show: name, provider/model chip, skill count, active indicator
- "Save" = save-in-place to active slot (or prompt for name if no slot)
- "Save As" = always prompts for a new name
- "Load" = loads with a confirmation modal if the active agent is dirty
- Templates panel: slide-in or separate section showing `library/default-agents/`

## Interaction with export (Phase 5)

The export endpoint (`GET /api/drafts/:folder/export`) exports the
**currently active** agent. A future enhancement can add per-entry
export: `GET /api/drafts/:folder/library/:slug/export`. For V1, students
should Save their agent before exporting to ensure the export reflects
a stable named version.

## Out of scope (V1)

- Per-entry conversation history. Sessions are tied to the agent
  group, not the library entry; switching agents starts a new thread.
- Sharing agents between students. That's a publishing flow; design
  separately.
- Version history / undo within an entry. The library IS the version
  list — each named entry is a version.
- Import from zip (the reverse of Phase 5 export). Natural follow-on.
- Collaborative agents / branches. Not a classroom-day-1 need.

## Open questions

1. **Memory on load:** default is "leave current memory alone." Should
   the load confirm modal offer a checkbox "Also restore memory
   snapshot from this agent"? Probably yes — makes it explicit.

2. **Active slot on first save:** if the student has never used the
   library, there is no `.active-slot`. The first Save should prompt
   for a name (= Save As). Or auto-name as "My first agent." Leaning
   toward auto-naming to reduce friction.

3. **Default agent population:** should each student's library be
   pre-seeded with one entry at provisioning time (a snapshot of their
   initial persona), so they always have something to revert to? Yes —
   this is the safest default.

4. **Max entries UX:** when the student hits 20, the "New Agent" and
   "Save As" buttons should be disabled with a "You have 20 agents —
   delete one to continue" tooltip rather than silently failing.
