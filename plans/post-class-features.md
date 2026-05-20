# Post-class follow-up features

Three features queued after the live class day. Independent — can land
in any order; doing them smallest-to-largest.

## Feature 1 — Per-call `model_call` trace event

**Why.** Today the agent-mode trace pane shows tool_use / tool_result
during a turn, then one cumulative `agent call` summary at the end.
For multi-step turns (codex iterating tool calls), users can't see
the per-call breakdown — only totals. The codex `thread/tokenUsage/
updated` notification fires per LLM response with a `last` field
giving that specific call's tokens. We surface that as a discrete
trace entry.

**Surface.**
- `container/agent-runner/src/providers/types.ts` — extend `ProviderEvent`
  union with `{ type: 'model_call'; tokensIn; tokensCached; tokensOut;
  tokensReasoning }`.
- `container/agent-runner/src/providers/codex.ts` — in the
  `thread/tokenUsage/updated` handler, also push a `model_call` event
  using `last` (deduped against the previous `last.totalTokens` so we
  don't emit twice for the same call).
- `container/agent-runner/src/poll-loop.ts` — extend the trace switch
  to forward `model_call` via `emitTraceToPlayground` alongside
  tool_use / tool_result.
- `src/channels/playground/public/tabs/chat.js` —
  `appendTraceEvent` renders `type: 'model_call'` with a summary line
  (tokens in/out, reasoning, cost via `computeAgentCallCost`).
- Container source is mounted RO so no image rebuild — kill the
  running container, next inbound spawns fresh.

**Done when.** A multi-tool codex turn shows N `model call` entries
interleaved with tool_use/tool_result, each with its own tokens + cost.

## Feature 2 — Auto-refresh codex catalog

**Why.** Today `BUILTIN_ENTRIES` for codex models is hand-maintained
in `src/model-catalog.ts`. When OpenAI ships a new codex model (or
retires one), we don't see it until someone edits the file. Auto-
fetch from `developers.openai.com/codex/models` keeps the catalog
current and drops models that disappear from OpenAI's docs.

**Surface.**
- New `src/model-catalog-refresh.ts` — fetches the page, extracts
  model IDs (and optionally pricing from the pricing-docs page), diffs
  against `BUILTIN_ENTRIES`, writes a refreshed list. Cached for ~24h
  via `data/codex-catalog-cache.json`. Failure (HTML layout change,
  network error) falls back to the in-source `BUILTIN_ENTRIES` — never
  empties the catalog.
- `src/index.ts` — kick off a refresh on host boot (non-blocking), so
  the catalog is current within the first minute of host life.
- `getModelCatalog()` — merges refreshed entries on top of `BUILTIN_
  ENTRIES` (refreshed wins by `id`). Local-file overrides
  (`config/model-catalog-local.json`) still win above both.

**Done when.** Restart host with stale BUILTIN_ENTRIES, watch logs
show `codex-catalog-refresh: N entries fetched`, hit
`GET /api/drafts/<f>/models` and see the new list.

**Risk.** OpenAI changes the HTML layout → parse fails → we silently
fall back. Add a log warning + JSON cache so consecutive failures
don't keep retrying. Not on the critical path for any flow.

## Feature 3 — Claude support in direct-chat

**Why.** Today `/api/direct-chat` only handles the OpenAI Chat
Completions wire format (codex + local via `/openai/v1` and
`/omlx/v1`). Students who want to test Claude models in the playground
have to go through agent mode (with its scaffold) instead of seeing
raw Claude behavior. Adding Claude branches to direct-chat closes
the gap.

**Surface.**
- `src/channels/playground/api/direct-chat.ts` — branch on `provider`:
  - `codex` → `/openai/v1/chat/completions` (existing)
  - `local` → `/omlx/v1/chat/completions` (existing)
  - `claude` → `/anthropic/v1/messages` (new — translate request +
    response between OpenAI and Anthropic shapes)
- `src/credential-proxy.ts` — already proxies the Anthropic default
  path; verify `/anthropic/v1/messages` routes correctly and the
  x-api-key header is substituted.
- Token / cost shapes match the existing field set (`tokensIn`,
  `tokensOut`, `tokensCached`, `costUsd`).

**Done when.** Pick `provider=claude` + a Claude model in the chat
tab's "Chat (no agent)" mode, send a message, see a real Claude reply
with tokens + cost in the response footer and a `direct call` entry
in the trace.

## Order

1. Feature 1 (smallest, immediate playground UX improvement)
2. Feature 2 (medium, host-side refactor)
3. Feature 3 (most surface area — request/response translation)

Each is its own commit. Pre-commit hook (prettier) runs on each.
Restart host + kill running containers as needed; mounted agent-
runner source means no image rebuild.
