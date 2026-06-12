# Simple Tab Trace Roll-Up — Design Spec

**Date:** 2026-06-12
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude
**Builds on:** [2026-06-11-simple-tab-layering-design.md](2026-06-11-simple-tab-layering-design.md) (shipped)

## Goal

Let the student **roll up the side panel** (everything below the toggle + agent name) to reveal a live **trace window underneath**, sitting on the same visual plane as the chat window. Reuse the Chat tab's trace panel — its look *and* its logic — rather than rebuilding it. This extends the layering metaphor to the right column: the panel is the agent's "surface," and the trace is the machinery underneath.

## Key insight (from context exploration)

The simple tab's embedded chat **already contains a fully live `.trace-panel`** — `mountChat` builds it and SSE events flow into it; it is merely hidden by `.simple-mode .trace-panel { display: none; }` (style.css:1663). The design re-parents that node instead of duplicating anything.

## Approved interaction decisions

1. **Affordance:** a small chevron button (`aria-expanded`) in the panel header, next to the toggle + name input. Clicking the peek strip also rolls up.
2. **Default state:** rolled down, with a **peek strip** below the panel — `🔍 trace — underneath` — mirroring the model strip's look, teaching that the trace exists.
3. **Both modes:** the roll-up works with Use-agent ON and OFF (direct mode emits trace calls too; comparing bare-model vs agent traces is the pedagogical point). The strip stays neutral gray in both modes.
4. **No persistence:** every page load starts rolled down.

## Architecture

### DOM (`public/tabs/simple.js`)

The right side becomes a stack mirroring the left:

```
.simple-layout
├── .simple-stack                 (left — unchanged)
└── .simple-side-stack            ← NEW wrapper (flex column, owns column sizing)
    ├── aside.simple-panel        (existing card)
    │   ├── .simple-panel-header  [toggle] [name input] [chevron ← NEW]
    │   └── .simple-panel-body    (existing — skills / personality / save)
    ├── .simple-trace-strip       ← NEW peek strip "🔍 trace — underneath"
    └── .simple-trace-host        ← NEW, empty in markup
```

**Re-parenting:** after `mountChat(chatHost)`, `mountSimple` moves the chat's live `.trace-panel` node into `.simple-trace-host`:

```js
el.querySelector('.simple-trace-host')
  .appendChild(el.querySelector('.simple-chat-host .trace-panel'));
```

SSE wiring survives — chat.js holds element references, and a moved node keeps them. The trace panel brings its own header ("Trace" label + Clear button) with it.

**State class:** `.trace-open` on the `.simple-mode` wrapper drives all visual changes (same pattern as `.agent-off`). The chevron toggles it; the strip click sets it.

| State | Panel body | Trace strip | Trace host |
|---|---|---|---|
| Rolled down (default) | visible | visible (peek) | hidden |
| Rolled up (`.trace-open`) | collapsed | collapsed | `flex: 1; min-height: 0` — fills the column to the chat's bottom edge |

### chat.js refactor (the enabler)

chat.js captures `const trace = el.querySelector('#trace-log')` once (line 299) for all SSE rendering, but **re-queries** inside the mount root at three later call sites:

- `chat.js:483` — direct-mode submit (`startNewTurn` + `appendDirectTraceCall`)
- `chat.js:525` — agent-mode submit (`startNewTurn`)
- `chat.js:598` — Clear-button click handler

Once the node moves outside the mount root, those re-queries return `null`. Fix: **reuse the already-captured `trace` reference** at all three sites — the line-299 `const` precedes them and all three are closures inside `mountChat`, so it is already in scope. Strict improvement — one capture, one source of truth. The Chat tab is unaffected: same element either way. Net diff ~6 lines changed, nothing added.

### CSS (`public/style.css`, simple-tab block)

- **Delete** `.simple-mode .trace-panel { display: none; }` (line 1663) — visibility is now controlled by the host element.
- `.simple-side-stack` — `flex: 1; min-width: 220px; display: flex; flex-direction: column; min-height: 0`.
- `.simple-panel` — loses `flex: 1`, `min-width: 220px`, `align-self: flex-start` (the stack owns column sizing); content-height inside the column. The fused/sunken treatments from the layering spec are untouched.
- `.simple-trace-strip` — clone of `.simple-model-strip`'s look (11px, `var(--text-faint)`, `var(--surface-alt)`, `margin: 0 10px` narrower-than-card, bottom-rounded), plus `cursor: pointer`.
- `.simple-trace-host` — `display: none` default; under `.simple-mode.trace-open`: `display: flex; flex-direction: column; flex: 1; min-height: 0; margin-top: 8px`, card border treatment (rounded, `var(--border)`) so the trace reads as its own surface.
- `.simple-mode.trace-open .simple-panel-body` — collapses via `max-height` transition (~600px cap → 0), `overflow: hidden`, padding collapsed, 0.3s ease. `.simple-mode.trace-open .simple-trace-strip` collapses like the OFF-state model strip.
- Chevron — small ghost button in the header; glyph/rotation swaps with state.
- `prefers-reduced-motion` block gains the new transitions.
- The existing `.trace-panel` / `.trace-header` / `.trace-log` rules (style.css:525–560) apply as-is — that is the point of reusing the node.

**Height chain (already proven on this tab):** `#tab-simple:not([hidden])` → `.simple-mode` → `.simple-layout` (`flex: 1; min-height: 0`) → `.simple-side-stack` → `.simple-trace-host` → `.trace-panel` (`flex: 1; min-height: 0`) → `.trace-log` (`overflow-y: auto`). Internal scrolling for free.

## Data flow

```
Chevron click / strip click → toggle .trace-open on wrapper + aria-expanded
                            → CSS collapses panel body + strip, expands trace host

SSE trace events → chat.js (unchanged paths) → the same #trace-log node,
                   now physically located in the right column
```

No new endpoints, no new state, no duplicated trace logic.

## Testing

- **happy-dom (`simple.test.ts`):**
  - After mount, the `.trace-panel` node lives inside `.simple-trace-host` (re-parent happened).
  - Chevron click adds `.trace-open` + flips `aria-expanded`; second click removes both.
  - Strip click rolls up.
  - Clear button still clears the re-parented trace (regression guard for the chat.js refactor).
- **Existing suites green:** full `pnpm test` — the chat-tab tests guard that the chat.js refactor didn't change Chat-tab behavior.
- **Live verification (Playwright):** roll up → trace fills to the chat's bottom edge (computed heights); send an agent message and a direct message with trace open → entries appear; Clear works; toggle OFF + rolled up still shows live trace entries; `pnpm run build` clean.
- Pure static-asset change — deploys on browser refresh, no host restart.

## Boundaries (out of scope)

- No changes to the advanced Chat tab's behavior (the chat.js refactor is reference hygiene, not behavior change).
- No trace persistence, filtering, or search.
- No drag-to-resize divider (chevron toggle only).
- The left column (agent card, model strip) is untouched.

## Risks / notes

- **Duplicate IDs:** both tabs mount chat.js, so `#trace-log` exists twice document-wide. chat.js uses el-scoped queries and (after the refactor) captured references, so instances stay independent — but any *new* code must never use `document.querySelector('#trace-log')`.
- **Re-parent timing:** the move must happen after `mountChat` returns (listeners attached) and is a one-time operation per mount; remounting the tab rebuilds everything, so no cleanup needed.
- **`max-height` animation cap:** the panel body's natural height varies (skills list + persona textarea). The ~600px cap must comfortably exceed it or the collapse animation will jump; verify against the tallest real panel.
- **OFF-mode interplay:** `.agent-off`'s `.simple-disabled` dimming targets the panel body, which is collapsed while rolled up — orthogonal, but the toggle round-trip while rolled up should be exercised live.
