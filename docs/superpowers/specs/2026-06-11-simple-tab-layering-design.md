# Simple Tab "Agent Above the Model" Layering — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude
**Builds on:** [2026-06-11-simple-my-agent-tab-design.md](2026-06-11-simple-my-agent-tab-design.md) (shipped)

## Goal

Make the My Agent tab *visually teach* that the agent sits between the student and the model. Agent mode should feel like a layer sitting **on top of** the raw model; flipping the Use-agent toggle should visibly remove that layer, dropping the student down onto the model. The metaphor extends to the side panel: the panel and the chat surface together are the agent layer.

## Visual concept (approved through option questions)

1. **Dynamic, toggle-driven** — the layers move when the toggle flips; the transition itself is the lesson.
2. **Visible under-card edge** — while the agent is ON, the model layer is a real card behind the chat surface; a thin labeled strip of it peeks out below the chat card.
3. **OFF = agent retracts into the side panel** — the panel is where the agent "lives." Toggling OFF drains the agent framing from the chat and sinks/grays the panel, leaving the chat sitting flat on the exposed model card. The model never appears "on top of" the agent.

### Agent ON

- Chat surface = the **agent card**: green-tinted framing (reuse the agent-bubble accent family: border `#bfe3c9`, label green `#2e7d46`), raised with a soft drop shadow.
- **Side panel fused to the agent card**: same elevation/shadow, same green border color — chat + panel read as one elevated layer.
- **Model strip**: a thin gray strip peeking out below the chat card, text `⚡ <model displayName> — underneath`. Decorative, not clickable. Proves the model layer exists beneath the agent.
- **Card header** (slim strip at the top of the chat card): `🤖 <agent name>`.

### Agent OFF

- Green framing drains to gray; drop shadow removed; chat frame becomes the **model card**: flat, gray, **dashed** border (echoing the existing `bubble-direct` styling family: `#aab4d4` dashes, label `#4a5a96`).
- Model strip collapses away — the student is now *on* the model layer, so nothing peeks beneath.
- Card header swaps to `⚡ <model displayName> — model only`.
- Side panel **sinks**: existing `.simple-disabled` dim/inert plus a sunken treatment (no shadow, slight inset shadow, gray border).

### Transition

- ~300 ms `ease` CSS transitions on the moving properties (border-color, box-shadow, background, strip collapse).
- Wrap motion in `@media (prefers-reduced-motion: reduce)` → transitions off, states still swap instantly.

## Architecture

All changes confined to the simple tab's own files. **Zero `chat.js` changes** — same boundary as the parent spec (CSS-hide + wrapper styling + programmatic reuse only).

### `public/tabs/simple.js`

- `mountSimple` DOM change: the chat host is wrapped —

  ```
  .simple-layout
    ├─ .simple-stack                ← new wrapper (left column)
    │    ├─ .simple-agent-card      ← new
    │    │    ├─ .simple-card-header  ← new slim header (text swaps with toggle)
    │    │    └─ .simple-chat-host    ← existing; mountChat target, unchanged
    │    └─ .simple-model-strip     ← new thin strip below the card
    └─ .simple-panel                ← existing
  ```

- `applyUseAgentToggle(wrapper, useAgent)` additionally toggles **one class** on the wrapper: `.agent-off` (present when the toggle is OFF). It also swaps the card-header text. All other visual changes are pure CSS keyed off `.agent-off`.
- Strip + header text updates ride the existing update paths: `applySelection` (model change) and the rename path — the same call sites that invoke `setBubbleLabels` today. A small helper (e.g. `setLayerLabels(wrapper, agentName, modelLabel)`) sets `textContent` on the strip and header; called wherever `setBubbleLabels` is called, plus on toggle flip.

### `public/style.css` (simple-tab block)

- ON-state rules: `.simple-agent-card` raised (green border, shadow, white/green-tint background); `.simple-panel` matching elevation + border; `.simple-model-strip` visible (gray background, small text).
- OFF-state rules under `.simple-mode .agent-off`: card → flat gray dashed; strip → collapsed (height/opacity to 0); panel → sunken (inset shadow, gray border) on top of the existing `.simple-disabled` dim.
- Transitions + `prefers-reduced-motion` guard.
- Accent hexes reuse the existing deliberate bubble accent families (`#bfe3c9`/`#2e7d46` green, `#aab4d4`/`#4a5a96` blue-gray); layout grays use existing design tokens.

## Data flow

```
Toggle flip → applyUseAgentToggle (single switch point)
            → clicks hidden #mode-agent/#mode-direct (existing)
            → toggles .agent-off on wrapper + swaps header text (new)
            → CSS transitions animate card/strip/panel between states

Model change / rename → existing applySelection / saveName paths
                      → setBubbleLabels (existing) + setLayerLabels (new)
```

No new endpoints, no new state, no chat.js coupling beyond the existing pinned hidden-control contract.

## Testing

- **happy-dom (`simple.test.ts`):**
  - `applyUseAgentToggle` OFF adds `.agent-off` to the wrapper and swaps the card-header text to the model label; ON removes the class and restores the agent name header.
  - `setLayerLabels` writes strip + header `textContent` from agent name + model label.
  - Existing 11 tests stay green (DOM scaffolding in tests gains the new wrapper elements where needed).
- **Manual:** flip the toggle on the deployed host — card visibly lifts/flattens, strip appears/collapses, panel sinks/rises; model dropdown change updates the strip text; rename updates the header.
- Build clean + full host suite green. Pure static-asset change — deploys on browser refresh, no host restart.

## Boundaries (out of scope)

- Bubble styling stays exactly as shipped (green/blue-gray labeled bubbles).
- No changes to the advanced Chat tab or `chat.js`.
- Strip is decorative — not a click target, no tooltip.
- No persistence; layering state derives entirely from the toggle.

## Risks / notes

- **Chat column height:** the new card header + model strip take ~2rem of vertical space from the chat host inside the same column — verify the chat scroll area still sizes correctly (the chat tab manages its own internal layout; the wrapper must keep `flex` sizing so `mountChat`'s column flexes within `.simple-agent-card`).
- **Strip text vs dropdown:** the strip must track the dropdown (live selection), not the saved agent config — same rule as `--model-label` in the parent spec.
- **`.simple-disabled` interplay:** the sunken panel treatment layers on top of the existing dim; keep the existing class untouched so the parent spec's tests keep passing.
