# "My Agent" Simple Tab — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

A beginner-mode playground tab — **My Agent** — that exposes exactly one simple surface: a chat window (with file attach), a **Use agent** toggle that flips between talking to the student's agent and talking to the raw model, a 4–6-item skill checklist with click-tooltips, an editable agent name, and an editable persona. Everything a beginner doesn't need (trace pane, provider/reasoning dropdowns, export, the other nine tabs) is out of sight. The instructor curates the whole experience through things that already exist: the default-participant template (skills shortlist + model choices + starting persona) and `tabsVisibleToStudents` (which tabs a student sees).

## Background (verified in code)

- **Chat tab already does 90% of the chat work** (`public/tabs/chat.js`, 1707 lines): `mountChat(el)` builds its own DOM (toolbar + chat column + trace panel), wires SSE streaming with reconnect backfill, file attach (image/PDF, 25 MB cap), and an **agent/direct mode switch** — `#mode-direct` posts the client-side `directHistory` to `POST /api/direct-chat` (host-side LLM call via the credential proxy, **no agent**: no system prompt, skills, or tools; supports openai-codex/openai-platform/local/clemson via Chat Completions and anthropic via Messages). Direct replies already get a distinct `bubble-direct` class; attachments in direct mode are rejected with a system note (text-only).
- **Skills:** `GET /api/skills/library` lists skills with SKILL.md frontmatter (incl. `description`); `GET/PUT /api/drafts/:folder/skills` reads/sets the agent's enabled skills (`string[] | 'all'`), student-permitted via `checkDraftMutation`. The PUT updates container config but does NOT stop the running container — skills load at spawn.
- **Persona:** `GET/PUT /api/drafts/:folder/persona` (used by the persona tab).
- **Models:** `GET /api/drafts/:folder/models` returns catalog + the student's `allowedModels` whitelist; `PUT /api/drafts/:folder/active-model` sets provider+model atomically (server resolves group→spec, C-5 logic). The chat tab's dropdowns filter by the student's whitelist + class controls.
- **Default-participant template** (`data/config/default-participant/`): `container.json` carries `skills` (`'all'` or list), `allowed_models`, `assistant_name`, model/provider; `CLAUDE.md` carries the default persona. Provisioning copies it into each new Participant.
- **Container stop helper:** `killGroupContainer(folder)` in `api/agent-library-handlers.ts` (module-local today — export it) stops running containers for a group so the next message respawns with fresh config.
- **Tab gating:** `app.js` `TABS` + `mounters`; students see `activeClass.tabsVisibleToStudents` ∩ TABS; owner/ta see all.
- **Agent identity:** `window.__pg.agent.{folder,name}`; `assistant_name` exists in container config but has **no student-facing write endpoint today**.

## Architecture

One new tab JS + small CSS, two tiny new endpoints, zero changes to chat.js logic (CSS-hide + programmatic reuse only).

### Component 1 — `public/tabs/simple.js` (the tab)

Layout: a top bar, then chat (left, ~70%) + "My agent" panel (right, ~30%).

- **Chat = the real chat tab, embedded.** `mountChat(chatHost)` is called unchanged inside a `.simple-mode` wrapper. Scoped CSS (`style.css`) hides: the trace panel, the Agent/no-agent mode buttons, the provider + reasoning dropdowns, the Export button, and the toolbar's own model select. All chat behavior (SSE, backfill, attach) is inherited.
- **Top bar (left-aligned):** a single **model dropdown** populated from the **template's** `allowed_models` (via `GET /api/simple-config`), labeled with catalog display names; falls back to the agent's current model as the only entry when the template list is empty. On change: `PUT /api/drafts/:folder/active-model`, AND sync the hidden chat `#provider-sel`/`#model-sel` (set values + dispatch `change`) so direct mode uses the same selection.
- **Side panel, top → bottom:**
  - **Header row: Use-agent toggle + editable agent name** (name inline, right of the toggle). Toggle drives the chat's existing mode machinery by programmatically clicking the hidden `#mode-agent`/`#mode-direct` buttons. OFF → every panel element below the header gets `.simple-disabled` (grayed, inert); ON → restored. Name edits save via `PUT /api/drafts/:folder/name` (on blur/Enter) and update the agent bubble label live.
  - **Skills checklist** — one row per shortlist skill (from `/api/simple-config`): checkbox + friendly title + ⓘ. Clicking ⓘ expands the skill's description inline (one open at a time). Checkbox state = membership in the agent's current skills list.
  - **Personality** — textarea pre-filled from `GET /api/drafts/:folder/persona`.
  - **Save my agent** — PUT skills (the checked set) + persona (+ name if dirty), then `POST /api/simple-restart` (see Component 3) so the next message uses the new setup; show "Saved! Your agent will use this from its next reply." Failures surface inline ("Couldn't save — try again"), never silently.
- **Reply differentiation (scoped CSS, no chat.js edits):** `simple.js` sets CSS vars on the wrapper — `--agent-label: "🤖 <name> — your agent"` and `--model-label: "⚡ <model> — model only (no skills, no personality)"` (updated on rename / model change). CSS: `.simple-mode .bubble-agent:not(.bubble-direct)` → green tint + `::before { content: var(--agent-label) }` header; `.simple-mode .bubble-direct` → blue-gray tint, dashed border, `::before { content: var(--model-label) }`.
- Registered as `simple` in `TABS` + `mounters` + `index.html`. **When `allowedTabs.length === 1`, `app.js` hides the tab strip** — a student stripped down to just this tab sees a single uncluttered page.

### Component 2 — `GET /api/simple-config` (member-readable)

In a new `api/simple-config.ts`. Returns what the simple tab needs that isn't already per-agent:

```json
{
  "skills": [{ "name": "image-gen", "title": "Image gen", "description": "<first sentence of SKILL.md description>", "enabled": true }],
  "models": [{ "provider": "openai-codex", "id": "gpt-5.4-mini", "displayName": "gpt-5.4-mini" }]
}
```

- `skills` = the **template's** skill list (`data/config/default-participant/container.json` → `skills`), each joined with its SKILL.md frontmatter `description` (first sentence for the tooltip; full name fallback if no description). `title` = the skill's folder name humanized (kebab→spaces, first letter capitalized: `image-gen` → "Image gen"). If the template's skills are `'all'` or the slot is missing, return the full library. `enabled` = membership in the **requesting student's agent's** current skills (resolved from `?folder=` after the same `canReadDraft` check the drafts endpoints use).
- `models` = the template's `allowed_models` resolved against the catalog; empty template list → `[{ the agent's current provider/model }]`.
- Auth: same session gate as other student endpoints + `canReadDraft(folder, userId)`.

### Component 3 — `PUT /api/drafts/:folder/name` + `POST /api/simple-restart`

- **`PUT .../name`** body `{ name: string }` (1–40 chars, trimmed, non-empty; 400 otherwise). Writes `assistant_name` in container config (`updateContainerConfigJson` + `materializeContainerJson`, the skills-PUT pattern) and updates the agent group's display name so `window.__pg.agent.name` and rosters agree. Gated by `checkDraftMutation`.
- **`POST /api/simple-restart`** body `{ folder }` — exports and reuses `killGroupContainer(folder)` so Save takes effect on the next message. Gated by `checkDraftMutation`. (Separate endpoint rather than baking the kill into the skills/persona PUTs — those are shared with the advanced tabs, where editing shouldn't bounce a working container mid-session.)

## Data flow

```
mount → GET /api/simple-config + GET drafts/:f/persona → render panel + top-bar dropdown
Toggle → click hidden #mode-agent/#mode-direct → chat.js's existing mode switch (direct → POST /api/direct-chat)
Model change → PUT drafts/:f/active-model + sync hidden chat selects → both modes use it
Save → PUT drafts/:f/skills + drafts/:f/persona (+ drafts/:f/name) → POST /api/simple-restart → next message respawns with new config
Bubble labels → CSS vars (--agent-label/--model-label) ← rename / model change
```

## Instructor story (no new admin UI)

1. Configure the default-participant template (existing Home card → editor): enable the 4–6 skills, check off the model choices in its Models tab, write the default persona.
2. Class Controls → set students' visible tabs to just `simple` (the existing `tabsVisibleToStudents` control gains the new tab as a checkbox option automatically).
3. New Participants provision from the template, so their starting persona/skills/model match what the simple tab presents as "default".

## Testing

- **Host (vitest):** `simple-config.test.ts` — member gate; template list → joined descriptions; `'all'`/missing slot → full library; `enabled` reflects the agent's skills; models fallback. Name PUT — validation (empty/long → 400), writes `assistant_name` + group name, draft-gate (403). Restart endpoint — gate + kill called for the right group.
- **Frontend (happy-dom):** `simple.test.ts` — panel renders shortlist with checked state; ⓘ toggles description; Use-agent OFF grays panel + activates direct mode (hidden button clicked); Save PUTs skills+persona and calls restart; rename updates `--agent-label`; model change PUTs active-model and syncs hidden selects.
- **Manual (browser):** full feel — toggle flip mid-conversation shows green vs blue-gray labeled bubbles; attach works in agent mode, noted-off in direct; tab strip hidden when the student has only this tab.
- Build clean + full host suite green. Tab JS/CSS deploy on browser refresh; the two new endpoints need a host restart.

## Boundaries (out of scope)

- **Attachments in direct mode** — existing text-only behavior stands.
- **Custom instructor tooltip text** — tooltips come from SKILL.md descriptions; an override layer can come later if descriptions prove too agent-facing.
- **Mode-switch chat divider** (option C) — not picked.
- **Per-student simple/full preference** — exposure is class-level via `tabsVisibleToStudents`.
- **No chat.js logic changes** — embed + CSS-hide only. If simple mode ever needs behavior chat.js can't express, that's a future `mountChat(el, opts)` refactor, not this project.

## Risks / notes

- **Hidden-control coupling:** the toggle and model sync drive chat.js's hidden controls programmatically (`#mode-agent`/`#mode-direct`/`#provider-sel`/`#model-sel`). Renaming those ids breaks the simple tab — the happy-dom tests pin the contract.
- **Direct-mode model labels:** `--model-label` must track the dropdown, not the agent config, since direct mode reads the selects live.
- **Template models vs the student's whitelist:** provisioning copies `allowed_models` from the template, but if the instructor later widens the template, existing students' hidden chat selects won't contain the new model — the sync must **append a missing `<option>`** before setting the value (direct mode reads `provSel.value`/`modelSel.value` verbatim). Agent mode is unaffected (`PUT active-model` is server-side).
- **Template `'all'` skills** shows the whole library (13 items today) — acceptable; the instructor narrows the template to get the curated 4–6.
- **`killGroupContainer` export** — it's module-local in `agent-library-handlers.ts`; export it rather than duplicating.
- **Deploy:** new endpoints are host-side (`dist/`) → host restart; `simple.js` + CSS are static → browser refresh.

## Suggested phasing (for the plan)

1. `GET /api/simple-config` (+ tests) — template skills ∩ library descriptions, template models, enabled state.
2. `PUT /api/drafts/:folder/name` + `POST /api/simple-restart` (+ tests).
3. `simple.js` skeleton: tab registration, layout, embedded `mountChat`, `.simple-mode` CSS hiding, tab-strip auto-hide.
4. Side panel: toggle + name + skills + persona + Save (+ happy-dom tests).
5. Reply styling: CSS vars + bubble label/tint CSS; top-bar model dropdown wiring.
6. Build + suite + deploy + live verify (owner seat first, then a participant seat) + state.md.
