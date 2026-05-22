# Agent Export — Design

> **Scope:** The "class takeaway" — a downloadable zip that lets a
> student re-deploy their customized agent in Claude Code, OpenAI
> Codex, Gemini CLI, a self-hosted NanoClaw (OpenClaw), or any other
> system (universal format). Targets day-1/day-2 students leaving the
> classroom who want to keep using their agent at home.

## Goal

A student at the end of a classroom session has:
- A persona they authored or customized (`CLAUDE.md`)
- Memory accumulated during class sessions (`CLAUDE.local.md`)
- A set of skills they've activated (`container.json` → `skills[]`)
- A model/provider selection (`container.json` → `provider` + `model`)

The export bundles those artifacts into one zip, with one subfolder
per target system, each containing everything needed to reproduce the
agent there. A generated `WHAT-I-BUILT.md` gives the student a
human-readable record of what they made and what it cost.

## What's NOT in scope

- Exporting session history (conversation transcripts). That's a
  separate privacy-sensitive operation; referenced in open questions.
- Exporting attachments (`groups/<folder>/attachments/`). Instructor
  data, not student agent identity.
- Per-student wiki contents (`/workspace/agent/wiki/`). Lives inside
  the container; a future "workspace export" feature covers it.
- Automated re-import into another NanoClaw instance. Import is Phase
  2 #7's follow-on; this phase only covers export.

## Source artifacts

Everything comes from two places on the host:

| Artifact | Source path |
|---|---|
| Persona + instructions | `groups/<folder>/CLAUDE.md` |
| Per-agent memory | `groups/<folder>/CLAUDE.local.md` (may not exist) |
| Provider + model + skills list | `groups/<folder>/container.json` |
| Built-in skill content | `container/skills/<name>/SKILL.md` for each name in `container.json.skills[]` |
| Custom skill content | `groups/<folder>/custom-skills/<name>/` — full directory tree per skill |
| Usage stats | `/api/usage/:folder` (thisMonth + total buckets) |

**Two kinds of skills:**
- **Built-in skills** are system-global (`container/skills/`), always a single `SKILL.md`.
  Referenced by name in `container.json.skills[]`. All students can use them; the
  group just activates or deactivates them.
- **Custom skills** are per-group (`groups/<folder>/custom-skills/<name>/`), can contain
  multiple files (up to 50), and belong exclusively to that student. Created and edited
  through the playground Skills tab. These are the student's original work and the
  most important export artifact after `CLAUDE.md`.

Both are included in the bundle. The runtime symlink mechanism (`syncSkillSymlinks` in
`container-runner.ts`) already gives custom skills priority over built-ins of the same
name — the export mirrors that: custom skills appear under `custom-skills/`, built-in
activations appear under `skills/`, and the target-system READMEs explain precedence.

## Bundle structure

```
<folder>-export.zip
├── README.md                    ← top-level: which format to choose
├── WHAT-I-BUILT.md              ← auto-generated summary of the agent
├── claude/
│   ├── README.md
│   ├── CLAUDE.md
│   ├── CLAUDE.local.md          (omitted if empty)
│   ├── skills/                  ← built-in activations (single SKILL.md each)
│   │   └── <name>/
│   │       └── SKILL.md
│   └── custom-skills/           ← student-created skills (full file tree)
│       └── <name>/
│           ├── SKILL.md
│           └── <any other files the student added>
├── openai/
│   ├── README.md
│   ├── CLAUDE.md
│   ├── CLAUDE.local.md
│   ├── skills/
│   │   └── <name>/SKILL.md
│   ├── custom-skills/
│   │   └── <name>/<all files>
│   └── config-snippet.toml      (MCP servers, if any)
├── gemini/
│   ├── README.md
│   ├── GEMINI.md                (CLAUDE.md + ## Available tools section)
│   └── GEMINI.local.md
├── openclaw/
│   ├── README.md
│   ├── CLAUDE.md
│   ├── CLAUDE.local.md
│   ├── container.json           (cleaned: no agentGroupId)
│   ├── skills/
│   │   └── <name>/SKILL.md
│   └── custom-skills/           ← full tree; NanoClaw uses it directly
│       └── <name>/<all files>
└── universal/
    ├── README.md
    └── agent.md                 (persona + memory + full skills inventory)
```

## Format details

### `claude/` — Claude Code

**What goes where:**
- Drop `CLAUDE.md` in any project root (or `~/.claude/CLAUDE.md` for
  global agent identity).
- Copy `skills/<name>/` folders to `~/.claude/skills/`.
- Copy `custom-skills/<name>/` folders to `~/.claude/skills/` as well
  (same destination — custom skills override built-ins of the same name,
  mirroring the classroom runtime behavior).
- If `CLAUDE.local.md` exists: drop alongside `CLAUDE.md` in the
  project root (Claude Code loads it as per-project memory).

**Generated README content:**
1. Install Claude Code: `npm install -g @anthropic-ai/claude-code`
2. Authenticate: `claude /login`
3. Place files as above (custom-skills/ goes into `~/.claude/skills/` too)
4. Run: `claude` in any project directory

**Notes:** Claude Code's `Skill` tool resolves `~/.claude/skills/`
natively; no config needed beyond the file placement. Student-authored
custom skills get priority over any identically-named built-in.

---

### `openai/` — OpenAI Codex CLI

**What goes where:**
- Drop `CLAUDE.md` in project root — Codex reads it and resolves
  `@-import` directives the same way Claude Code does.
- Copy `skills/<name>/` to `~/.claude/skills/` (Codex resolves the
  same path; the `claude` name is intentional — shared convention).
- Copy `custom-skills/<name>/` to `~/.claude/skills/` too (same
  destination, same priority logic as Claude Code).
- If `CLAUDE.local.md` exists: drop alongside `CLAUDE.md`.
- Apply `config-snippet.toml` (if non-empty) into `~/.codex/config.toml`
  to wire any MCP servers.

**Generated README content:**
1. Install Codex: `npm install -g @openai/codex`
2. Authenticate: `codex login`
3. Place files as above
4. Run: `codex` in any project directory

**Notes:** The `config-snippet.toml` only contains a MCP servers block
if `container.json` had non-empty `mcpServers`. Most student exports
will have an empty toml snippet and the README says to skip it.

---

### `gemini/` — Gemini CLI

**What goes where:**
- Drop `GEMINI.md` in project root — Gemini CLI reads this file.
- Drop `GEMINI.local.md` alongside it.

**GEMINI.md construction:**
- Base: `CLAUDE.md` content verbatim.
- Appended section `## Available tools` — one bullet per skill:
  built-in activations first, then custom skills (marked `[custom]`).
  Uses each skill's `name` + first sentence of `description`.
  This surfaces skill capabilities as plain-text context (Gemini CLI
  has no native skill-discovery mechanism comparable to Claude Code's
  `Skill` tool). Full custom-skill SKILL.md content is NOT inlined —
  Gemini has no equivalent invocation path; the bullet is enough to
  tell the model the capability exists.

**Generated README content:**
1. Install Gemini CLI: `npm install -g @google/generative-ai-cli` (or
   the current install path from Google's docs)
2. Authenticate: `gemini auth login`
3. Place files as above
4. Run: `gemini` in any project directory

**Notes:** Full SKILL.md recipe files are NOT included in the gemini
bundle — Gemini CLI doesn't invoke them. The tool-listing section in
GEMINI.md describes capabilities but the student will need to invoke
them manually or adapt to Gemini's own tool system.

---

### `openclaw/` — Self-hosted NanoClaw

**What goes where:**
- Create a fresh NanoClaw install (link to qwibitai/nanoclaw README).
- Copy the `openclaw/` subfolder to `groups/<folder>/` on the new host.
- Create the agent group: `ncl groups create --folder <folder>`.
- Wire to a messaging group and restart the service.

**`container.json` cleaning:** Strip `agentGroupId` (host-specific) and
`groupName` / `assistantName` if the student wants a fresh identity.
Keep `provider`, `model`, `skills`, `mcpServers`, `packages`.

**Generated README content:**
1. NanoClaw install: link to qwibitai/nanoclaw setup guide
2. Copy folder, create group, wire messaging group
3. Start service — agent resumes with the same persona and memory

---

### `universal/` — Portable (ChatGPT custom instructions, Cursor, any LLM)

**`agent.md` construction (three sections):**

```markdown
# <assistantName from container.json> — Agent Export

## Instructions
<CLAUDE.md content verbatim>

## Memory
<CLAUDE.local.md content, or "(no memory recorded)" if absent>

## Skills
<one bullet per active skill: **<name>** — <description first sentence>>
```

**Use cases:**
- Paste "Instructions" into ChatGPT's "Custom instructions" field.
- Add as a Cursor `.cursorrules` file.
- Drop in any tool that accepts a system-prompt text file.
- Read it yourself to understand what you built.

---

## `WHAT-I-BUILT.md` — auto-generated summary

Generated from live data; never requires editing. Intended as a
"show your work" artifact students can share.

```markdown
# What I Built — <assistantName>

**Class:** <from class-config.json if available, else "(standalone)">
**Model used:** <provider>/<model> from container.json
**Built-in skills:** <comma-list of activated built-in skill names>
**Custom skills:** <comma-list of student-created skill names, or "(none)">
**Total tokens:** <total.tokensIn + total.tokensOut> in + out
**Total cost:** $<total.costUsd> since first session
**This month:** $<thisMonth.costUsd>

## What my agent can do

<one bullet per skill (built-ins then custom): **<name>** — <description first sentence>>
<custom skills flagged with `[custom — you built this]`>

## About the agent

<CLAUDE.md first paragraph, stripped of YAML frontmatter>
```

The "sample exchanges" idea was considered but cut: transcripts carry
student-generated content and may contain personal information. A
future "export conversation history" feature covers that separately
with explicit consent framing.

## API surface

```
GET /api/drafts/:folder/export
Query params:
  format   one of: all | claude | openai | gemini | openclaw | universal
           default: all

Response:
  Content-Type: application/zip
  Content-Disposition: attachment; filename="<folder>-export.zip"
  Body: zip stream

Errors:
  401  not authenticated
  403  canReadDraft gate fails (wrong user for this folder)
  404  agent group not found
  500  zip assembly failure
```

`format=all` is the default and the only UI-exposed option in V1.
Individual format params are available for scripts and future UI
("export just the claude bundle").

## Auth

Same gate as all draft reads: `canReadDraft(folder, userId)`. Owner,
global admin, scoped admin, and members all pass. A student can always
export their own agent group.

## UI trigger

A single "Export agent" button in the playground. For V1:
- Location: the three-dot menu on the Chat tab (or the Persona tab
  header — wherever feels natural to implement; the spec doesn't
  mandate placement).
- Action: `GET /api/drafts/:folder/export` → browser downloads the zip.
- No modal needed for V1; format=all is sufficient for the class
  takeaway use case.

## Open questions

1. **Empty `CLAUDE.local.md`.** Include in bundle as an empty file
   (preserves the convention that it exists) or omit entirely?
   Current spec: omit if empty to keep the zip clean.

2. **Skills not found on disk.** `container.json` may reference a
   skill name that doesn't exist in `container/skills/` (deleted,
   typo). Current spec: skip silently and omit from the bundle;
   note in the README for that format that skills could not be resolved.

3. **MCP servers in container.json.** Most students won't have any.
   If they do: include the server name + command in `config-snippet.toml`
   (OpenAI) and note in the universal README. Don't include secrets.

4. **Zip vs. directory download.** Zip is simpler and works in all
   browsers. Directory download requires FileSystem Access API (Chrome-only).
   Current spec: zip.

5. **`--format` in the CLI (`ncl`).** A `ncl groups export` command
   is a natural follow-on for headless use (scripts, CI). Out of scope
   for V1; the API endpoint is already callable with curl.
