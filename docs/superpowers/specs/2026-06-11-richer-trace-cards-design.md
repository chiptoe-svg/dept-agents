# Richer Live Trace Cards — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** owner + Claude

## Goal

Make the Chat tab's live trace pane render each tool use as **one** clear card with an explicit success/error status and a meaningful, tool-aware preview — instead of today's two-cards-per-tool with no status distinction and a generic payload preview. Pure client-side rendering polish; live-only; the owner's own agent pane (no persistence, no cross-agent view, no backend/SSE/DB change).

## Background (verified)

The trace pane already exists and is mature (`src/channels/playground/public/tabs/chat.js`): per-turn grouping with a cost/latency footer (`startNewTurn`/`finalizeTurn`), native pi-event rendering (`appendPiEvent` + `piHandle*`), collapsible `<details>` cards, streaming assistant bubbles, and a thinking panel. Events arrive live over SSE (`/api/drafts/:folder/stream` → `delivery.ts` pushes native `pi_event`s).

Three concrete gaps:

1. **Two cards per tool use.** `piHandleToolcallEnd` (keyed by `contentIndex`) renders a "tool call · `<name>`" card with args; `piHandleToolExecutionStart/Update/End` (keyed by `toolCallId`) renders a *separate* "tool exec `<name>`" card with args + result + a `running…`/result status. `toolcall_end` already stamps `card.li.dataset.toolCallId = tc.id`, so the linkage exists but the cards aren't merged. State lives in `trace._piState.toolCallCards` (contentIndex→card) and `trace._piState.toolExecCards` (toolCallId→card).
2. **No success/error distinction.** `piHandleToolExecutionEnd` always shows `formatTracePreview(result)` + adds `trace-pi-tool-exec-done`. An error result (`"Fetch failed: …"`, `"Web search failed: …"`, `"blocked by egress policy: …"`) looks identical to success. **The authoritative signal exists:** the `tool_execution_end` event carries `isError: boolean` (pi-agent-core `types.d.ts:387–391`) alongside `result: AgentToolResult`. It is a native field on the event, forwarded verbatim by the SSE pipeline.
3. **Generic previews.** `formatTracePreview(args)` / `formatTracePreview(result)` are tool-agnostic; they don't surface the meaningful bit (web_search's `query`, fetch_url's `url`, bash's command; or "N results"/error on the result side).

**Testability:** the `piHandle*` functions are module-internal (not exported); `refreshChatModels`/`mountChat` are the only exports. There are **no automated tests** for the renderer (only a commented `__pgTestPiEvent` manual hook). `happy-dom` IS a dev dependency (`package.json`), just not yet used for `public/` JS. Vitest supports per-file `// @vitest-environment happy-dom`.

Pi tool-call event order for one invocation: `toolcall_start` (contentIndex) → `toolcall_delta` → `toolcall_end` (carries `toolCall.id` = the `toolCallId`, `name`, `arguments`) → `tool_execution_start` (`toolCallId`, `toolName`, `args`) → `tool_execution_update`* → `tool_execution_end` (`toolCallId`, `result`, `isError`).

## Architecture

All changes are in `src/channels/playground/public/tabs/chat.js` (+ a new test file). No backend/SSE/DB changes.

### Component 1 — Unify into one card keyed by `toolCallId`

Collapse the call (name+args) and the execution (status+result) into a single `<details>` card per `toolCallId`.

- Introduce `trace._piState.toolCards` keyed by `toolCallId`; phase out the separate `toolExecCards` rendering. Keep `toolCallCards` keyed by `contentIndex` **only** for the pre-`toolcall_end` pending window (we don't have the `toolCallId` until `toolcall_end`).
- `piHandleToolcallStart` — unchanged in spirit: create a pending card keyed by `contentIndex` (we have no id yet), summary `tool call · pending…`.
- `piHandleToolcallEnd` — when `tc.id` arrives: take the pending card for `contentIndex`, fill the tool name + args (tool-aware preview, Component 3), **rekey it into `toolCards[tc.id]`** (and drop the `contentIndex` entry), and set `dataset.toolCallId`. If no pending card exists (missed start), create one.
- `piHandleToolExecutionStart` — **look up `toolCards[toolCallId]` first**; if present, attach the result placeholder + a `running…` status to that existing card (do NOT create a second card). Only create a fresh card if none exists (execution without a preceding `toolcall_end`, e.g. host-injected tools).
- `piHandleToolExecutionUpdate` / `piHandleToolExecutionEnd` — operate on `toolCards[toolCallId]`, writing the streamed/final result into the same card's body + status slot.
- Net: one card shows `tool · <name>` (status badge) / preview / expandable args **and** result.

### Component 2 — Success/error status badge

In `piHandleToolExecutionEnd`, classify the outcome and reflect it on the unified card:

- **Primary signal:** `event.isError === true` → error; otherwise success. (Verify in impl that `isError` survives the SSE pipeline on a real trace; it's a native event field, so it should.)
- **Defensive fallback** (only when `isError` is absent/undefined): treat the result as an error if its text matches a known marker — `/^(Web search failed|Fetch failed|blocked by egress policy|Error\b|HTTP [45]\d\d)/i` (these are NanoClaw's tools' error-string prefixes). Otherwise success.
- Rendering: success → a `✓` glyph + `trace-tool-ok` class (green accent, reusing the existing `trace-tool_result` `#87a96b`); error → a `✗` glyph + `trace-tool-error` class (red accent, e.g. `#c0504d`). Set the class on the card `li` and show the glyph in the summary. Add the two CSS classes (the trace CSS lives alongside the other `trace-*` rules — follow the existing accent-border pattern).

### Component 3 — Tool-aware previews

Two small pure helpers, with a fallback to the existing `formatTracePreview`:

- `previewForToolArgs(name, args)` → web_search: `args.query`; fetch_url: `args.url`; bash/terminal: `args.cmd ?? args.command`; default: `formatTracePreview(args)`.
- `previewForToolResult(name, result, isError)` → on error: the first line of the result text (trimmed, ~80 chars); web_search success: a count if derivable (e.g. "N results" parsed from the result text/shape) else the generic preview; default: `formatTracePreview(result)`.
- Used to fill the card summary preview at `toolcall_end` (args) and `tool_execution_end` (result). Unknown tools degrade to today's behavior.

### Component 4 — Testability

- **Export** from `chat.js`: `appendPiEvent` and the two new pure helpers (`previewForToolArgs`, `previewForToolResult`), plus a small `classifyToolResult(event)` returning `'ok' | 'error'`. (Exporting `appendPiEvent` is enough to drive the DOM via synthetic events; the `piHandle*` internals stay private.)
- **New test** `src/channels/playground/public/tabs/chat-trace.test.ts` with `// @vitest-environment happy-dom`. Importing `chat.js` must remain side-effect-free (it only declares functions + exports; `mountChat` is called by the app, not on import — verify).

## Data flow (unchanged transport)

```
agent turn → pi_event over SSE (/stream) → chat.js appendPiEvent
  toolcall_start  → pending card (contentIndex)
  toolcall_end    → rekey to toolCards[toolCallId], name + args + tool-aware preview
  tool_exec_start → same card: running…
  tool_exec_end   → same card: status badge (isError) + tool-aware result preview + full result
```

## Testing

Vitest + happy-dom (`src/channels/playground/public/tabs/chat-trace.test.ts`):

- **Unify:** feeding `toolcall_start`/`toolcall_end`/`tool_execution_start`/`tool_execution_end` for one `toolCallId` produces **exactly one** `.trace`/tool card under the turn (assert card count = 1, and it carries both the args and the result).
- **Status:** `tool_execution_end` with `isError:true` → card has `trace-tool-error` (✗); with `isError:false` → `trace-tool-ok` (✓). Fallback: `isError` undefined + result text `"Fetch failed: …"` → error.
- **Tool-aware preview:** `web_search` args `{query:'weather'}` → summary preview contains `weather`; `fetch_url` `{url:'https://x'}` → contains the url; unknown tool → falls back to the generic formatter (non-empty, no throw).
- **Pure helpers:** unit tests for `previewForToolArgs`/`previewForToolResult`/`classifyToolResult` (no DOM).
- **No-regression:** a plain text-only turn (message_start → text_delta → message_end) still renders the assistant bubble + footer (a quick happy-dom assertion).

Build clean (`pnpm run build`) + the new test green + existing host suite unaffected.

## Boundaries (out of scope)

- **Per-tool duration** (deselected — the turn footer already sums latency; trivial later add).
- Trace **persistence/replay** and **cross-agent operator view** (the other gap options, not chosen).
- Any backend/SSE/DB change; any change to `delivery.ts` or the event payloads.
- Direct-chat (non-agent) trace rendering — unchanged.
- Extracting the full renderer into its own module (chat.js is large, but a 400-line move is scope creep here; exporting the needed fns is sufficient).

## Risks / notes

- **Card rekey ordering.** The contentIndex→toolCallId rekey at `toolcall_end` is the trickiest bit; the unify tests cover the normal order and the two fallbacks (exec-without-toolcall_end; toolcall_end-without-pending-start). Parallel tool calls (multiple in one turn) must each get their own card — the test should include two concurrent `toolCallId`s.
- **`isError` pipeline.** Confirm on a real trace that `tool_execution_end.isError` reaches the client (it's a native event field; the SSE push forwards the event verbatim). The string-prefix fallback covers the case where it doesn't.
- **No image rebuild / no host restart** — this is playground static JS served from `src/channels/playground/public/`; a browser refresh picks it up. (Pure client-side; the agent containers are untouched.)
- Client-measured anything is avoided (we dropped duration), so there's no timing-accuracy concern.

## Suggested phasing (for the plan)

1. Pure helpers (`previewForToolArgs`, `previewForToolResult`, `classifyToolResult`) + their unit tests (export from chat.js).
2. Unify the card (rekey by `toolCallId`, merge toolcall + exec) + happy-dom test for single-card + parallel calls.
3. Status badge (isError + fallback) + CSS classes + test.
4. Wire tool-aware previews into the card summaries + test; no-regression text-turn test. Build + verify.
