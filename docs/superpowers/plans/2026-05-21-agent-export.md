# Agent Export — Implementation Plan

> **Design:** [`docs/superpowers/specs/2026-05-21-agent-export-design.md`](../specs/2026-05-21-agent-export-design.md)
> **Master plan:** [`plans/master.md` §Phase 2 #7](../../../plans/master.md)

**Goal.** `GET /api/drafts/:folder/export` returns a zip containing
five format subfolders (claude / openai / gemini / openclaw /
universal) plus `WHAT-I-BUILT.md`. A single "Export agent" button in
the playground triggers it. No import yet.

**Files touched:**
- `src/channels/playground/api/export.ts` (new — bundle assembly)
- `src/channels/playground/api-routes.ts` (register the new route)
- `src/channels/playground/public/app.js` (export button)
- `src/channels/playground/server.ts` (import route registration if needed)
- `pnpm-lock.yaml` / `package.json` (add `jszip` or `archiver`)

**Not touched:** container skills tree (read-only), groups/ folder
contents (read-only from the export handler).

---

## Phase A — Source assembler

Read and normalize all artifacts from disk for a given folder. Pure
functions, no HTTP. Isolated so the bundle generators can be tested
without touching the API layer.

- [ ] Create `src/channels/playground/api/export.ts`
- [ ] `readAgentSources(folder: string): AgentSources | null`
  - Reads `groups/<folder>/CLAUDE.md` (required; return null if missing)
  - Reads `groups/<folder>/CLAUDE.local.md` (optional; null if absent)
  - Reads + parses `groups/<folder>/container.json` (required for
    skills list + provider/model; graceful defaults on parse failure)
  - **Built-in skills:** for each name in `container.json.skills[]`:
    reads `container/skills/<name>/SKILL.md`; skips silently if not found.
    Reads frontmatter (`name`, `description`) + body.
  - **Custom skills:** calls `listCustomSkills(folder)` from
    `src/channels/playground/custom-skills.ts`, then for each:
    calls `listCustomSkillFiles(folder, name)` and
    `readCustomSkillFile(folder, name, relPath)` for every file.
    Stores as a map of `relPath → content` per skill so bundle
    generators can write the full directory tree.
  - Returns `AgentSources` struct (see below)
- [ ] Define `AgentSources` type:
  ```typescript
  interface SkillEntry {
    name: string;         // frontmatter name (or dir name if no frontmatter)
    description: string;  // frontmatter description (full)
    body: string;         // full SKILL.md content (built-in) or '' (custom)
  }
  interface CustomSkillEntry {
    name: string;
    description: string;  // from SKILL.md frontmatter
    files: Record<string, string>;  // relPath → file content (all files)
  }
  interface AgentSources {
    folder: string;
    assistantName: string;    // container.json.assistantName ?? folder
    provider: string;
    model: string;
    claudeMd: string;
    claudeLocalMd: string | null;
    builtinSkills: SkillEntry[];    // from container.json.skills[]
    customSkills: CustomSkillEntry[];  // from groups/<folder>/custom-skills/
    mcpServers: Record<string, unknown>;
  }
  ```
- [ ] Unit test: `readAgentSources` returns expected struct for a known
      folder; returns null for nonexistent folder
- [ ] Unit test: missing `CLAUDE.local.md` → null in struct (not error)
- [ ] Unit test: built-in skill name not found → skipped without throwing
- [ ] Unit test: `customSkills` array populated when
      `groups/<folder>/custom-skills/` exists with at least one skill;
      empty array when directory absent

---

## Phase B — Usage + WHAT-I-BUILT generator

Reuse the existing `/api/usage/:folder` logic to pull lifetime token
and cost totals. Assemble `WHAT-I-BUILT.md` as a string.

- [ ] Add `generateWhatIBuilt(sources: AgentSources, usage: UsageResponse | null): string`
  - Header: assistantName, provider/model
  - Built-in skills: comma-list (or "(none activated)")
  - Custom skills: comma-list with `[custom]` marker (or "(none)")
  - Skills "what I can do" bullets: builtins then custom (custom flagged
    with `[custom — you built this]`)
  - Cost + token totals from usage (graceful "usage data unavailable"
    if null)
  - First paragraph of `CLAUDE.md` (strip YAML frontmatter if present)
- [ ] Unit test: generates expected markdown for a mock AgentSources
      (no live DB needed)
- [ ] Unit test: graceful when usage is null

---

## Phase C — Bundle generators (one per format)

Each generator takes `AgentSources` and returns a
`Record<string, string>` mapping `path-within-bundle → file-content`.
No zip logic inside the generators — keeps them testable as pure
string transforms.

- [ ] `buildClaudeBundle(s: AgentSources): Record<string, string>`
  - `claude/CLAUDE.md` → `s.claudeMd`
  - `claude/CLAUDE.local.md` → `s.claudeLocalMd` (omit if null)
  - `claude/skills/<name>/SKILL.md` → skill body for each builtin skill
  - `claude/custom-skills/<name>/<relPath>` → all files for each custom
    skill (preserves full directory tree from `customSkill.files`)
  - `claude/README.md` → generated
- [ ] `buildOpenAIBundle(s: AgentSources): Record<string, string>`
  - Same structure as claude bundle (skills/ + custom-skills/)
  - `openai/config-snippet.toml` → MCP servers block (omit if empty)
  - `openai/README.md` → generated
- [ ] `buildGeminiBundle(s: AgentSources): Record<string, string>`
  - `gemini/GEMINI.md` → `s.claudeMd` + appended `## Available tools`
    section: built-ins first, then custom skills marked `[custom]`
  - `gemini/GEMINI.local.md` → `s.claudeLocalMd` (omit if null)
  - `gemini/README.md` → generated
  - NOTE: custom-skills/ NOT included in gemini bundle — Gemini has
    no skill-invocation path; listing in GEMINI.md is sufficient
- [ ] `buildOpenClawBundle(s: AgentSources): Record<string, string>`
  - `openclaw/CLAUDE.md`, `CLAUDE.local.md`
  - `openclaw/skills/<name>/SKILL.md` for each builtin skill
  - `openclaw/custom-skills/<name>/<relPath>` for ALL custom skill files
    (NanoClaw uses this directory directly — highest-fidelity export)
  - `openclaw/container.json` → cleaned (strip `agentGroupId`; keep
    provider, model, skills, mcpServers, packages)
  - `openclaw/README.md` → generated
- [ ] `buildUniversalBundle(s: AgentSources): Record<string, string>`
  - `universal/agent.md` → three sections (Instructions / Memory /
    Skills). Skills section lists builtins then custom skills;
    custom ones flagged with `[custom — you built this]`
  - `universal/README.md` → generated
- [ ] Unit tests for each bundle generator:
  - All expected paths present for a fully-populated AgentSources
  - Empty builtinSkills + customSkills → no skills/ or custom-skills/
    entries, no "Available tools" section in Gemini
  - Null claudeLocalMd → local.md path absent
  - Custom skill with multiple files → all file paths present in
    claude/openai/openclaw bundles; NOT in gemini bundle
  - OpenClaw container.json: `agentGroupId` stripped, rest preserved

---

## Phase D — Zip assembly + API endpoint

Wire everything together into the HTTP handler.

- [ ] Add `jszip` (or `archiver`) to `package.json` + `pnpm install`
  - Prefer `jszip` (no native bindings, pure JS, WAL with better-sqlite3
    already in the process). Check `minimumReleaseAge` compliance before
    adding.
- [ ] `buildExportZip(sources: AgentSources, whatIBuilt: string, format: string): Promise<Buffer>`
  - Assembles all bundles (or just the requested one) into a JSZip
  - Adds top-level `README.md` (which format to pick)
  - Adds top-level `WHAT-I-BUILT.md`
  - Returns zip buffer
- [ ] `handleExport(folder, userId, format): Promise<ApiResult<Buffer>>`
  - `canReadDraft(folder, userId)` → 403 if false
  - `readAgentSources(folder)` → 404 if null
  - Fetch usage via `handleUsage(folder, userId)` — ignore errors
  - `generateWhatIBuilt(sources, usage)`
  - `buildExportZip(...)`
  - Return `{ status: 200, body: buffer, contentType: 'application/zip',
    filename: '<folder>-export.zip' }`
- [ ] Register route in `api-routes.ts`:
  `GET /api/drafts/:folder/export` → `handleExport`
  - Response headers: `Content-Type: application/zip`,
    `Content-Disposition: attachment; filename="<folder>-export.zip"`
- [ ] Integration test: `GET /api/drafts/<bench-folder>/export` with
      a bench session cookie returns HTTP 200 + zip content-type
- [ ] Build clean: `pnpm run build`

---

## Phase E — UI trigger

Single button in the playground; no modal in V1.

- [ ] Add "Export agent ↓" to the three-dot / overflow menu on the
      Chat tab header (or Persona tab — wherever owner/admin context
      menus already live; follow existing pattern in `app.js`)
- [ ] On click: `window.location.href = '/api/drafts/<folder>/export'`
      (triggers browser download directly — no fetch needed for zip)
- [ ] Visible to: owner, admin, the student themselves (same `canReadDraft`
      population). Hidden for users with no write/member access.
- [ ] Manual test: click button, zip downloads, unzip shows five
      subfolders + WHAT-I-BUILT.md

---

## Phase F — README content

Write the four format-specific READMEs and the two top-level ones.
These are the "instructions where to put things" the user asked for.
Do this last so the generator functions are stable before writing the
prose.

- [ ] `claude/README.md` template — install CLI, place files, run
- [ ] `openai/README.md` template — install Codex, place files, apply
      config-snippet.toml if non-empty, run
- [ ] `gemini/README.md` template — install Gemini CLI, place files, run
- [ ] `openclaw/README.md` template — NanoClaw setup link, copy folder,
      `ncl groups create`, wire messaging group, restart
- [ ] `universal/README.md` template — paste Instructions into ChatGPT
      custom instructions / Cursor / any LLM
- [ ] Top-level `README.md` template — "Your NanoClaw agent, exported.
      Pick the folder matching the tool you want to use."

---

## Completion criteria

- [ ] `GET /api/drafts/:folder/export` returns a valid zip for a
      student folder (claude-sonnet bench group works as a smoke target)
- [ ] Zip contains all five format subfolders + `WHAT-I-BUILT.md` +
      top-level `README.md`
- [ ] `claude/CLAUDE.md` matches the group's `CLAUDE.md` verbatim
- [ ] `gemini/GEMINI.md` ends with an `## Available tools` section
      listing each active skill
- [ ] `openclaw/container.json` has no `agentGroupId` field
- [ ] `WHAT-I-BUILT.md` lists provider/model and at least one skill
- [ ] 403 for a user without read access to the folder
- [ ] Build clean, existing tests pass
- [ ] Manual download + unzip in browser works end-to-end

---

## Estimated effort

| Phase | Time |
|---|---|
| A — Source assembler | ~45 min |
| B — WHAT-I-BUILT generator | ~30 min |
| C — Bundle generators (5×) | ~60 min |
| D — Zip + API endpoint | ~45 min |
| E — UI trigger | ~20 min |
| F — README content | ~30 min |
| **Total** | **~3.5 hr** |
