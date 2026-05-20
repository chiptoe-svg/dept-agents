# Skills tab redesign — 3-panel browser / preview / editor

## Goal

Replace the current 4-region Skills tab (Available skills · Preview ·
Active skills) with three panels:

1. **Left — file browser.** Categorized skill list (Library / Anthropic /
   Custom). Active skills carry a **clickable green toggle**; clicking it
   activates/deactivates the skill in place. Replaces the old
   "+ Add to active →" button and "×" remove buttons. Cost/latency rollup
   moves to a footer here.
2. **Middle — preview.** Read-only preview of the selected skill
   (file tree + file body). Unchanged behaviour.
3. **Right — editor.** Editable `SKILL.md` textarea (persona-tab style).
   Saving prompts for a name and writes a **per-agent custom skill** that
   then appears under "Custom" in the left browser. Library/built-in
   skills are never mutated — editing one and saving forks a named copy.

## Design decisions (confirmed with user)

- **Edit target:** per-agent. Saving creates a *named* custom skill that
  shows up under "Custom" in the left panel. Shared library/built-in
  skills are read-only sources.
- **Green marker:** clickable toggle (activate/deactivate).

## Architecture facts

- Skills are shared: `container/skills/<name>/` (built-in) or the cloned
  `anthropics/skills` cache. Active skill = a symlink created at spawn
  into `.claude-shared/skills/<name>` → `/app/skills/<name>`.
- `container.json.skills` (string[] | 'all') is the per-agent active set.
- New: **custom skills live per-agent** at
  `groups/<folder>/custom-skills/<name>/SKILL.md`. The group folder is
  mounted into the container at `/workspace/agent`, so a custom skill is
  visible at `/workspace/agent/custom-skills/<name>`.

## Status

Phases 1–5 complete (Phase 5 = multi-file custom skills + file editor).
Unit tests + build + host restart all done; the browser end-to-end check
(author multi-file skill → toggle → reload → agent uses it) is the
remaining manual step.

## Phase 1 — Backend: per-agent custom skills ✅

- [x] New `src/channels/playground/custom-skills.ts`:
  - `listCustomSkills(folder)` → `{name, description}[]` (reads each
    `custom-skills/<name>/SKILL.md` frontmatter `description`).
  - `readCustomSkill(folder, name)` → `SKILL.md` text | undefined.
  - `writeCustomSkill(folder, name, content)` — validates name vs
    `NAME_RE`, writes `SKILL.md`.
  - `deleteCustomSkill(folder, name)` → boolean.
  - `customSkillExists(folder, name)`.
- [x] Routes in `api-routes.ts` (inline, like the existing skill routes):
  - `GET  /api/drafts/:folder/custom-skills` → `{ entries }`
  - `GET  /api/drafts/:folder/custom-skills/:name` → `{ text }`
  - `PUT  /api/drafts/:folder/custom-skills/:name` → write; gated by
    `checkDraftMutation(folder, 'skills_put', userId)`.
  - `DELETE /api/drafts/:folder/custom-skills/:name` → delete; same gate.
- [x] `syncSkillSymlinks` in `container-runner.ts`: accept the group dir;
  for each desired skill, target
  `/workspace/agent/custom-skills/<name>` when
  `<groupDir>/custom-skills/<name>/` exists, else `/app/skills/<name>`.
  Also correct an existing symlink whose target no longer matches.

## Phase 2 — Frontend: rewrite `tabs/skills.js` ✅

- [x] Three-panel `skills-layout`: `.library-panel` (left),
  `.preview-panel` (middle), `.skills-editor` (right).
- [x] `loadSkillLibrary`: fetch `/api/skills/library` + per-agent
  `/api/drafts/:folder/custom-skills`; merge custom entries with
  `category:'custom'`.
- [x] Left list: each row = icon + name + a `.skill-toggle` green button.
  Toggle click → add/remove from `currentSkills` → `saveActive`.
  Row click → select → preview (middle) + load into editor (right).
- [x] Middle preview: built-in/anthropic → existing file-tree endpoints;
  custom → custom-skill GET.
- [x] Right editor: textarea + name input + Save + Delete.
  - Selecting a custom skill → name prefilled, editing in place.
  - Selecting a library/built-in skill → name blank (placeholder),
    Save forks a new custom skill.
  - "+ New skill" → blank editor.
  - Save: reject names colliding with non-custom skills (frontend has
    full `libraryCache`); `PUT` then refresh + reselect.
  - Delete: enabled only for custom skills; also drop from active set.
- [x] Cost/latency rollup → footer of the left panel.

## Phase 3 — CSS ✅

- [x] `.skills-layout` 3-column; `.skill-toggle` green pill (+`.active`);
  `.skills-editor` panel; editor name row + footer.
- [x] Remove now-dead skills-only CSS (`.active-skills`, `.active-entry*`,
  `.active-remove`, `.active-cost`, `.preview-footer`, `.skill-active`,
  `.active-all-banner`). Keep persona-shared classes.

## Phase 4 — Verify (manual browser check pending)

- [x] `custom-skills` unit tests (list/read/write/delete + name validation).
- [x] `pnpm run build` clean; full host suite (841 tests) green.
- [x] Host restarted clean.
- [ ] Reload Skills tab in the browser; author a custom skill, toggle it
  active, confirm it survives reload and the agent picks it up.

`syncSkillSymlinks` is an unexported internal — not unit-tested (exporting
solely to test it would be scope creep). Its target-selection change is
covered by the manual browser check above.

## Phase 5 — Multi-file custom skills ✅

Custom skills become real directories (multiple files), the editor follows
the file selection, and authoring supports adding files.

- [x] `custom-skills.ts` → per-file API: `listCustomSkillFiles`,
  `readCustomSkillFile`, `writeCustomSkillFile(relPath, content)` with
  rel-path traversal validation. `listCustomSkills`/`deleteCustomSkill`
  unchanged.
- [x] Routes: `GET .../custom-skills/:name/files`, `GET|PUT
  .../custom-skills/:name/file?path=`. Drop the single-file `:name`
  GET/PUT; keep `:name` DELETE.
- [x] `skills.js` editor → an in-memory working set `{relPath: content}`:
  - A file strip in the editor panel: one chip per file + `+ file`.
  - Clicking a chip (or a file in the middle preview tree) switches the
    edited file; the current buffer is stashed first.
  - `+ file` prompts for a name and adds a blank file (`.md` → `# ` stub).
  - Selecting a library/built-in skill loads ALL its files as a fork
    basis; selecting a custom skill loads its files for in-place edit.
  - Save writes every working-set file via per-file PUT.
- [x] CSS for the editor file strip.
- [x] Update `custom-skills` tests for the per-file API.

## Out of scope

- Per-file delete inside a skill (delete the whole custom skill instead).
- Renaming a custom skill (use save-as + delete).
- A template picker — `+ New skill` seeds a `SKILL.md`; added files are
  blank (or a `# ` stub for `.md`).
