# Trace-call disclosure — model_call and agent_call

## Status — 2026-05-20: response disclosure shipped (prompt disclosure deferred)

Landed a focused subset of this plan — **response text only**, no feature flag, no full request bodies:

- `model_call` (Codex) carries an optional `responsePreview` (the turn's `agentMessage` text, capped 5000 chars). Set on `item/completed(agentMessage)`, consumed by the next `model_call` emission so tool-use-only calls don't inherit stale text. `types.ts` + `codex.ts` + `poll-loop.ts` pass-through.
- `agent_call` needs **no provider change** — the assistant text is already in the chat-reply SSE payload (`data.content.text`); `appendAgentTraceCall` just renders it now. Covers Claude (which emits no per-call `model_call` — its turn *is* the `agent_call`).
- `chat.js`: `appendModelCallTrace` / `appendAgentTraceCall` wrap the summary line in a `<details>`/`<summary>` when response text is present (reuses the existing `.trace-details` CSS from the tool-call disclosure).
- Tests: `codex.factory.test.ts` drives `runOneTurn` against a fake app-server — verifies preview attaches after `agentMessage`, is absent on tool-use-only calls, isn't carried onto a later call, and truncates at 5000.

Still deferred (out of scope of the 2026-05-20 pass): `promptPreview`, the `tracePayloadDetail` knob, full request/response bodies, and key redaction. Revisit per the "Why deferred" note below if an instructor needs prompt-side visibility.

---

Today's Phase 1.7 trace panel rework added:
- Turn-grouping with timestamp header + totals footer
- Visible disclosure triangle (▶ / ▼) on **tool** entries that already carry rich payload

Tool entries already show the full `input` and `content` of the tool call/result when expanded. Model_call and agent_call entries don't — they only show a one-line summary (tokens, latency, cost). The server doesn't emit prompt/response in those events.

This plan captures the deferred work to make model_call and agent_call disclosable. Not blocking; sits behind class-day priorities.

## Goal

Clicking the ▶ triangle on a `MODEL CALL` or `AGENT CALL` trace entry expands to show:
- The user-visible prompt (or the most recent user message that triggered the LLM turn)
- The model's full text response
- (Optional) System prompt and tool-definitions overhead, so the instructor can see why "yolo" cost $0.0846 in a 16k-input agent turn

## What needs to change

### Agent-runner side

Files: `container/agent-runner/src/providers/claude.ts`, `container/agent-runner/src/providers/codex.ts`, (eventually `opencode.ts`, `ollama.ts`).

Each provider currently emits `ProviderEvent { type: 'model_call', tokensIn, tokensOut, tokensCached, tokensReasoning }` after the model call returns. Add (under a feature flag):

```ts
emit({
  type: 'model_call',
  tokensIn, tokensOut, tokensCached, tokensReasoning,
  // NEW — optional, omitted if disabled by flag or oversize
  promptPreview: string,    // last ~500 chars of input.messages.last() (truncated, escaped)
  responsePreview: string,  // last ~500 chars of response.content (truncated)
  // OR full payloads with a size cap:
  inputBody: string,        // full JSON-stringified request body, cap 16KB, redact API keys
  outputBody: string,       // full JSON-stringified response, cap 16KB
})
```

Decision points before implementation:
- **Preview vs. full body?** Preview is cheaper (network bandwidth + storage) but loses fidelity. Full body with a cap is the dev-tools experience. Lean: preview by default + a `tracePayloadDetail: 'preview' | 'full' | 'none'` knob in the agent_group config.
- **Where to truncate.** Beginning, end, or middle? Beginning keeps the most-recent context. Per-tool-result truncation already happens upstream in the tool result events; reuse that helper.
- **Redaction.** Strip any API-key-shaped substrings (`sk-…`, `ant-…`, OAuth bearer tokens) from emitted bodies. The credential-proxy header `x-api-key` shouldn't appear in user-visible traces.

Same change for `agent_call` (the per-turn summary event) — should include the user message + final assistant message.

### Host side

`src/db/session-db.ts` (the `messages_out` schema or a sibling trace table) needs columns to persist prompt/response previews. Or stash JSON in an existing `trace_event` blob if that already exists. Verify the schema first.

Wire format on the SSE stream (`src/channels/playground/sse.ts`?) just forwards what the agent-runner emits. Likely zero-change if it already does a pass-through serialization.

### Client side

`src/channels/playground/public/tabs/chat.js`. Modify `appendModelCallTrace` and `appendAgentTraceCall` to render a `<details>`/`<summary>` envelope (mirroring `appendTraceEvent`'s pattern):

```js
function appendModelCallTrace(trace, data) {
  // ... existing one-line summary becomes the <summary> content ...
  if (data.promptPreview || data.responsePreview) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    // summary = existing summary line
    // body = <pre> with prompt + "→" separator + response
  } else {
    // existing flat render (graceful degradation when feature is off)
  }
}
```

CSS for `.trace-details > .trace-summary::before` triangle is already there from today's work — same selector applies.

### Tests

- `container/agent-runner/src/providers/claude.test.ts` and `codex.test.ts`: verify the new event fields land on a fixture model call.
- A redaction unit test: feed in a request with `x-api-key: sk-XXX`, assert the emitted `inputBody` has the key masked.
- A size-cap test: feed a 100KB response, assert truncated to ≤ 16KB with a marker.

## Estimate

- Provider changes: 1-2 hr (claude + codex)
- Host pass-through: 30 min (probably no schema change if we use existing `trace_event` blob)
- Client render: 30 min
- Tests + verification: 1 hr
- **Total: ~3-4 hr** of focused work, best as a single subagent-driven-development session.

## Out of scope (for now)

- Full request replay UI ("re-run this turn with edited prompt"). Bigger feature; needs its own design pass.
- Tool-call argument schema rendering. Tool calls already disclose; the next step would be syntax-highlighting JSON args, but that's polish.
- Multi-provider parity. Land on claude + codex first; opencode and ollama follow when someone hits the need.

## Why deferred

- Not blocking class-day operations (trace panel is debug-tier UX, not student-facing)
- Server-side work touches the agent-runner which has a separate package tree (Bun runtime) and tsconfig — needs careful test setup
- The current trace panel already has tool-call disclosure for the most useful case (seeing what a tool actually did)

Revisit when: an instructor needs to debug "why did this turn cost $X" or "why didn't the agent use my system prompt the way I expected," and the existing summary line isn't enough.
