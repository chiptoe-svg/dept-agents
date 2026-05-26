# Phase C — Pi Port with Native Events (Option D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the parallel-dispatch sections or superpowers:executing-plans for sequential. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pi as a registered agent provider in classroom, lifting the adapter from `nanoclaw_personal` with two architectural adaptations:
1. **Credential-proxy instead of OneCLI** — drop personal's OneCLI assumptions; use the classroom's HTTP-layer credential proxy.
2. **Option D event passthrough** — pi-agent-core's native events flow unchanged to the playground trace via a new `pi_event` variant on `ProviderEvent`. The `chat.js` renderer is reworked to consume pi's vocabulary directly. Trace gets a strict upgrade (streaming text, thinking deltas, per-tool live updates).

Also fixes the HIGH-priority pi bugs identified in `plans/pi-personal-audit-2026-05-25.md` during the port so classroom doesn't inherit them.

**Architecture:** Pi runs inside the existing agent container alongside Claude SDK and Codex (which are deleted in the separate Phase D plan). Pi-agent-core manages its own session, MCP bridge, and provider selection internally. The container-side adapter `pi.ts` is a thin wrapper that subscribes to pi's event stream and forwards events through the poll-loop's `ProviderEvent` shape. The trace pipeline (poll-loop → emitTraceToPlayground → outbound.db → SSE → chat.js) carries pi events end-to-end.

**Tech Stack:** TypeScript on Bun (container) + Node (host). pi-* packages from `@earendil-works/*` at 0.75.4. Credential-proxy at `:3001` (existing classroom infrastructure).

**Prerequisites:**
- Phase B½ complete (tag `phase-bhalf-complete-2026-05-25`). Pi consumes the new container-configs DB API.
- Personal at v2.0.69 has working pi integration to lift from.
- Phase 0 verification of pi double-emit bug is complete (verified in earlier session — it was narrower than first audit thought).

**Out of scope (separate plans):**
- Deleting claude.ts and codex.ts (Phase D)
- UI hardcoding cleanup beyond what's needed for pi to render (Phase D)
- `class-codex-auth.ts` removal (Phase D)
- Per-student pi auth configuration

---

## File structure

**Files created (lifted from nanoclaw_personal, adapted):**

```
src/providers/pi.ts                                                    # Host-side container config (adapt: drop OneCLI NO_PROXY)
container/agent-runner/src/providers/pi.ts                             # Container-side adapter (adapt for credential-proxy + Option D)
container/agent-runner/src/providers/pi-auth.ts                        # Auth resolver (rewrite for proxy not OneCLI)
container/agent-runner/src/providers/pi-mcp-bridge.ts                  # MCP-to-pi tool bridge (lift unchanged)
container/agent-runner/src/providers/pi-model.ts                       # Model alias resolution (lift unchanged)
container/agent-runner/src/providers/pi-tools/web-search.ts            # Web search tool (adapt: drop OneCLI HTTPS_PROXY)
container/agent-runner/src/providers/pi.test.ts                        # Unit tests
container/agent-runner/src/providers/pi.factory.test.ts                # Factory tests
container/agent-runner/src/providers/pi.smoke.test.ts                  # Smoke test (live API gated)
container/agent-runner/src/providers/pi-auth.test.ts                   # Auth tests
container/agent-runner/src/providers/pi-mcp-bridge.test.ts             # Bridge tests
container/agent-runner/src/providers/pi-model.test.ts                  # Model tests
container/agent-runner/src/providers/pi-tools/web-search.test.ts       # Web search tests
container/CLAUDE.providers/pi.md                                       # Provider fragment
```

**Files modified:**

```
container/agent-runner/src/providers/types.ts                          # Add pi_event variant to ProviderEvent
container/agent-runner/src/providers/index.ts                          # Add `import './pi.js';`
container/agent-runner/src/providers/factory.ts                        # Wire pi into createProvider
src/providers/index.ts                                                 # Add `import './pi.js';`
src/channels/playground/public/tabs/chat.js                            # Rework trace renderer for pi events
container/agent-runner/package.json                                    # Add @earendil-works/pi-* deps at 0.75.4
container/agent-runner/bun.lock                                        # Updated by bun install
```

---

## Conventions

- **Working branch:** `catchup/phase-c-2026-05-25` off `phase-bhalf-complete-2026-05-25` tag
- **Commit per task:** each task gets its own commit with `c-N:` prefix
- **After every task:** run `pnpm run build` + relevant tests; verify green before moving on
- **Subagent dispatch:** use sonnet for the lift-and-adapt tasks (mechanical), opus reserved for any design questions that arise
- **Always run `pnpm run build` yourself**
- **Use codegraph for structural lookups** before grep where possible
- Container tests use `bun test`, host tests use `pnpm test` (vitest)

---

## Task c-0 (can run in parallel with Phase B½): chat.js trace renderer rework

This is the highest-effort task in Phase C and is fully independent of B½. If dispatching agents, kick this off as soon as Phase B½-1 lands so it runs in parallel with the rest of B½.

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js`

**Agent brief:**

> Rework the trace-panel renderer in `/Users/admin/projects/nanoclaw/src/channels/playground/public/tabs/chat.js` to consume pi-agent-core's native event vocabulary, in addition to classroom's existing `ProviderEvent` shape.
>
> Context: Classroom currently emits trace events as `{ type: 'tool_use' | 'tool_result' | 'model_call' }` from poll-loop via `emitTraceToPlayground`. With pi as a harness (forthcoming task c-6), pi-agent-core's events will flow through unchanged as `{ type: 'pi_event', event: <native pi event> }`. The plan adopts pi's vocabulary as the canonical format ("Option D"). Trace gets a strict upgrade.
>
> Pi-agent-core event vocabulary to support:
>
> | Event | Carries | Render as |
> |---|---|---|
> | `agent_start` | empty | (internal marker — no UI) |
> | `turn_start` | `{ turnId }` | Section divider with turn number |
> | `message_start` | `{ message: {role} }` | Begin new bubble in trace panel |
> | `message_update` with `assistantMessageEvent.type === 'text_delta'` | `{ delta }` | Append `delta` to current bubble live |
> | `message_update` with `assistantMessageEvent.type === 'thinking_delta'` | `{ delta }` | Append to a collapsible "thinking" panel |
> | `message_update` with `assistantMessageEvent.type === 'toolcall_start'` | `{ contentIndex }` | Begin tool call card |
> | `message_update` with `assistantMessageEvent.type === 'toolcall_delta'` | `{ contentIndex }` | Stream tool args |
> | `message_update` with `assistantMessageEvent.type === 'toolcall_end'` | `{ toolCall: { name, arguments, id } }` | Finalize tool call card |
> | `message_end` | `{ message }` | Seal the bubble; show usage if present |
> | `tool_execution_start` | `{ toolCallId, toolName, args }` | Begin tool execution status |
> | `tool_execution_update` | `{ partialResult }` | Stream partial result if available |
> | `tool_execution_end` | `{ toolCallId, result }` | Finalize execution result |
> | `turn_end` | `{ message, toolResults }` | Section close; aggregate cost if available |
> | `agent_end` | `{ messages }` | (internal marker — no UI) |
>
> Specific changes:
> 1. Add a new render path keyed on the wrapper shape `{ type: 'pi_event', event: <native> }`. Dispatch on `event.type` (the inner pi event type) and route to the appropriate rendering function.
> 2. Keep the existing render paths for `tool_use`, `tool_result`, `model_call` so claude/codex sessions still render correctly during the Phase D deletion window.
> 3. Add a "Thinking" collapsible panel (default collapsed) per assistant message, populated by `thinking_delta` events.
> 4. Streaming text rendering: `text_delta` events append to a single growing bubble (do not create a new bubble per delta).
> 5. Per-message usage display (input/output/cache tokens, cost) — read from `message_end.message.usage` if present.
> 6. Tool-call-card detail expansion: click to show full args + result.
> 7. Use existing CSS classes / styling — don't introduce new visual paradigms.
>
> Verification:
> - Open the playground in a browser
> - Manually trigger a pi_event via the dev console: paste a synthetic wrapped event into the SSE handler and verify it renders. Use this synthetic example:
>   `{ type: 'pi_event', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } } }`
> - Confirm existing claude trace events still render unchanged (sanity check: send a message to an existing claude-backed agent group).
>
> Return: every section added or modified with line refs. List the synthetic test events used for manual verification.

After return, stage `src/channels/playground/public/tabs/chat.js` and commit with subject `feat(playground): chat.js trace renderer for pi-native events (c-0)`.

---

## Task c-1: Add pi packages to container deps

**Files:**
- Modify: `container/agent-runner/package.json`
- Will update: `container/agent-runner/bun.lock`

- [ ] **Step 1: Create the working branch**

Run: `cd /Users/admin/projects/nanoclaw && git checkout phase-bhalf-complete-2026-05-25 && git checkout -b catchup/phase-c-2026-05-25`

- [ ] **Step 2: Add deps to container package.json**

In `container/agent-runner/package.json` `dependencies`, add three entries pinned to `0.75.4`:
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Match the personal install's pins exactly.

- [ ] **Step 3: bun install**

Run: `cd container/agent-runner && bun install`

- [ ] **Step 4: Verify lock + commit**

Stage `container/agent-runner/package.json` and `container/agent-runner/bun.lock`. Commit with subject `deps(container): add pi packages at 0.75.4 (c-1)` and body noting that pi-tui is pulled transitively.

---

## Subagent dispatch point: tasks c-2 through c-5 in parallel

After c-1 lands (deps available), dispatch 4 sonnet agents to lift the small pi support files in parallel. They touch different files and have no shared mutable state.

---

## Task c-2 (parallel): Port pi-mcp-bridge.ts unchanged

**Agent brief:**

> Copy `pi-mcp-bridge.ts` and `pi-mcp-bridge.test.ts` from `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/providers/` to `/Users/admin/projects/nanoclaw/container/agent-runner/src/providers/`, unchanged.
>
> This file is provider-agnostic — it bridges MCP-shaped tools into pi's tool format. No OneCLI references; no classroom-specific adaptation needed.
>
> Verification:
> 1. Run `cd /Users/admin/projects/nanoclaw && pnpm tsc -p container/agent-runner/tsconfig.json --noEmit` — clean
> 2. Run `cd container/agent-runner && bun test src/providers/pi-mcp-bridge.test.ts` — green
>
> Return: confirmation of clean lift + test pass.

After return, stage both files and commit with subject `feat(provider): lift pi-mcp-bridge.ts unchanged (c-2)`.

---

## Task c-3 (parallel): Port pi-model.ts unchanged

**Agent brief:**

> Copy `pi-model.ts` and `pi-model.test.ts` from `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/providers/` to `/Users/admin/projects/nanoclaw/container/agent-runner/src/providers/`, unchanged.
>
> File contains model alias resolution (`haiku` → `claude-haiku-4-5`, etc.) and thinking-level mapping. No OneCLI or classroom-specific concerns.
>
> Verification:
> 1. `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit` — clean
> 2. `cd container/agent-runner && bun test src/providers/pi-model.test.ts` — green
>
> Return: confirmation.

After return, stage both files and commit with subject `feat(provider): lift pi-model.ts unchanged (c-3)`.

---

## Task c-4 (parallel): Port pi-tools/web-search.ts adapted

**Agent brief:**

> Copy `pi-tools/web-search.ts` and its test from `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/providers/pi-tools/` to `/Users/admin/projects/nanoclaw/container/agent-runner/src/providers/pi-tools/`, adapted for the credential-proxy.
>
> Critical adaptation: The personal version assumes OneCLI's HTTPS_PROXY injects the credential ("OneCLI's gateway injects the credential" per the file's comment). In classroom, there is no OneCLI HTTPS_PROXY — the credential-proxy is path-prefix-based (`/openai/`, `/googleapis/`, etc.), not host-based.
>
> Specific changes:
> 1. Add an explicit `X-Subscription-Token` (or equivalent — read the personal file's comments and the upstream tool docs to confirm the right header) sourced from `WEB_SEARCH_API_KEY` env var. The credential-proxy doesn't intercept the search provider's API; the container must include the credential directly.
> 2. Update the file-level comment to explain: classroom adds the header explicitly because there's no OneCLI HTTPS_PROXY gateway.
> 3. Remove the personal-specific "Linda gets natively from Claude Agent SDK" comment.
> 4. Remove the "onecli secrets create" instruction from the 401 error hint; replace with "Set WEB_SEARCH_API_KEY in your .env file".
> 5. Do not route the call through the credential-proxy — let it go direct to the search API (e.g. api.search.brave.com or whatever the file uses).
>
> Verification:
> 1. `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit` — clean
> 2. `cd container/agent-runner && bun test src/providers/pi-tools/web-search.test.ts` — green (update test fixtures if they hardcode OneCLI assumptions)
>
> Return: diff vs personal, with the OneCLI removal points highlighted.

After return, stage both files and commit with subject `feat(provider): lift pi-tools/web-search.ts, adapted for credential-proxy (c-4)`.

---

## Task c-5 (parallel): Port pi-auth.ts adapted for credential-proxy

**Agent brief:**

> Port `pi-auth.ts` from `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/providers/pi-auth.ts` to `/Users/admin/projects/nanoclaw/container/agent-runner/src/providers/pi-auth.ts`, restructured for credential-proxy.
>
> Critical architectural difference: In personal, `pi-auth.ts` resolves credentials inside the container at request time — OneCLI substitutes them at the HTTPS_PROXY level using placeholder env vars (`ANTHROPIC_AUTH_TOKEN=sk-ant-oat-placeholder`). In classroom, the credential-proxy injects credentials at the HTTP layer at the `/openai/`, `/googleapis/` etc. prefixes — the container just needs placeholder env vars present and pi will hit the proxy URL.
>
> What pi-auth in classroom should do:
> 1. For Anthropic (`modelProvider: 'anthropic'`): return `{ apiKey: process.env.ANTHROPIC_API_KEY }` if api-key mode (proxy substitutes the real key on `x-api-key` header), or `{ apiKey: process.env.CLAUDE_CODE_OAUTH_TOKEN }` if oauth mode (proxy substitutes on `Authorization: Bearer`). The container is configured by container-runner to point pi-ai at `ANTHROPIC_BASE_URL=http://host.docker.internal:3001`, so the proxy intercepts.
> 2. For OpenAI-codex (`modelProvider: 'openai-codex'`): read OAuth tokens from `/workspace/.pi-auth/auth.json` (same pattern as personal — this path is bypassed by the proxy because chatgpt.com isn't an OpenAI Platform API). Use the same `adaptForeignAuth` logic personal has for converting ChatGPT desktop-app token format.
> 3. For other pi-routable providers (DeepSeek, OpenAI Platform, Groq, etc.): return the env var value if present (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, etc.). Pi will use the proxy if the provider's base URL points there, or go direct if not.
>
> Specific changes from personal version:
> 1. Drop `PLACEHOLDER_ENV_BY_PROVIDER` for anthropic — classroom uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (not `ANTHROPIC_AUTH_TOKEN`). The proxy reads the standard headers.
> 2. Keep the openai-codex auth.json reading + adaptForeignAuth verbatim — that path is independent of the proxy/OneCLI choice.
> 3. Keep `getOAuthApiKey` rewrite on token refresh for the openai-codex path.
> 4. Simplify the `PLACEHOLDER_ENV_BY_PROVIDER` table — many entries in personal are OneCLI-specific. Reduce to providers the classroom credential-proxy supports plus env-var passthroughs for direct providers (deepseek, groq, etc.).
>
> Reference: Read `/Users/admin/projects/nanoclaw/src/credential-proxy.ts` to confirm exactly which providers it routes (anthropic, openai, omlx, google) and what env vars/headers it expects.
>
> Verification:
> 1. `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit` — clean
> 2. `cd container/agent-runner && bun test src/providers/pi-auth.test.ts` — green (update test fixtures: tests of OneCLI-specific behavior become tests of proxy-compatible behavior)
>
> Return: new pi-auth.ts shape, diff vs personal (focus on the architectural difference: container-side resolution vs proxy-layer injection).

After return, stage both files and commit with subject `feat(provider): lift pi-auth.ts, adapted for credential-proxy (c-5)`.

---

## Task c-6 (sequential, after c-2 through c-5): Port pi.ts adapter with Option D

**Files:**
- Modify: `container/agent-runner/src/providers/types.ts` (extend ProviderEvent)
- Create: `container/agent-runner/src/providers/pi.ts`
- Create: `container/agent-runner/src/providers/pi.test.ts`
- Create: `container/agent-runner/src/providers/pi.factory.test.ts`
- Create: `container/agent-runner/src/providers/pi.smoke.test.ts`
- Create: `src/providers/pi.ts` (host-side)
- Create: `src/providers/pi.test.ts`

- [ ] **Step 1: Extend ProviderEvent type with pi-native passthrough variant**

In `container/agent-runner/src/providers/types.ts`, add a new variant to the `ProviderEvent` union:

```
| { type: 'pi_event'; event: unknown }
```

Add a comment explaining: pi-native event passthrough — when pi is the harness, events are forwarded unchanged so the playground trace panel renders pi's richer vocabulary directly. The `event` field is the AgentHarnessEvent from pi-agent-core; kept as `unknown` so this file has no dependency on pi packages.

- [ ] **Step 2: Lift pi.ts (container-side) from personal**

Copy `/Users/admin/projects/nanoclaw_personal/container/agent-runner/src/providers/pi.ts` to the same path in classroom as the starting point.

- [ ] **Step 3: Apply Option D — passthrough events instead of translating**

Three structural changes vs the personal source:

1. Replace the entire `harness.subscribe` callback body with a passthrough that pushes both an `activity` event (for the heartbeat) and a `pi_event` wrapper with the unmodified pi event. Specifically: when pi fires any event, the adapter should call `queue.push({ type: 'activity' }, { type: 'pi_event', event });`. No more `partialAssistantText`, no more `tool_execution_start`/`end` to-`progress` translation — pi's events go through as-is.

2. Keep emission of `init`, `cost`, `result`, `error` since those are the lifecycle events the poll-loop's `handleEvent` cares about for non-trace concerns (session continuation, cost tracking, completion). The pi_event passthrough is additive.

3. Drop the personal-specific imports that don't make sense in classroom (e.g. anything that referenced OneCLI directly).

- [ ] **Step 4: Inline the async-generator wrapper and fix error double-emit**

Per `plans/pi-personal-audit-2026-05-25.md` Phase 0 verification:
- Inline the no-yield async-generator wrapper. Personal's `pi.ts:354-370` IIFE iterates a generator that has no yields — the for-await body is unreachable. Replace by moving the generator's body directly into the IIFE. Same behavior, ~30 fewer lines.
- Pick ONE error-emission site (either the inner try/catch at personal's line 332 or the IIFE catch at personal's line 361) and delete the other. Errors currently fire twice on any provider failure.

- [ ] **Step 5: Fix the personal HIGH-priority bugs while porting**

Per `plans/pi-personal-audit-2026-05-25.md`:

1. **sessionsRoot hardcode (personal pi.ts:172)**: make `/workspace/pi-sessions` configurable via an env var (`PI_SESSIONS_ROOT`) with the current value as the default.
2. **modelProvider undefined throw (personal pi.ts:223)**: instead of throwing if `options.modelProvider` is undefined, fall back to `'anthropic'` with a warning log. Read from `container.json`'s `provider` field as the default if available via the new container_configs API.
3. **HTTP MCP bridge silently dead (personal pi.ts:191)**: wire `hostMcpUrl` and `nanoclawSessionId` through `ProviderOptions` so `createPiMcpBridge` actually receives them. The classroom container-runner must pass these in container env so the bridge can be constructed correctly.

- [ ] **Step 6: Lift pi.ts (host-side) from personal**

Copy `/Users/admin/projects/nanoclaw_personal/src/providers/pi.ts` to the same path in classroom, then apply these adaptations:
1. Remove the `NO_PROXY=chatgpt.com,auth.openai.com` env injection — classroom's credential-proxy doesn't have OneCLI's reject-unmatched-hosts behavior. No proxy bypass needed.
2. Remove the `ANTHROPIC_AUTH_TOKEN=sk-ant-oat-placeholder` env injection — classroom uses `ANTHROPIC_API_KEY` placeholders that the credential-proxy substitutes via standard x-api-key/Bearer headers.
3. Keep the auth.json copy for openai-codex (path mount unchanged from personal).
4. Update the file-level comment to explain the classroom adaptation: proxy-based credential injection instead of OneCLI gateway.

- [ ] **Step 7: Lift all pi test files from personal**

Copy `pi.test.ts`, `pi.factory.test.ts`, `pi.smoke.test.ts` (gated by `RUN_PI_LIVE=1` env), and `src/providers/pi.test.ts`. Update fixtures that assert OneCLI-specific behavior to assert proxy-compatible behavior instead.

- [ ] **Step 8: Run all checks**

Run from `/Users/admin/projects/nanoclaw`:
1. `pnpm run build`
2. `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit`
3. `pnpm test`
4. `cd container/agent-runner && bun test src/providers/`

All clean.

- [ ] **Step 9: Commit**

Stage all created/modified files for c-6. Commit with subject `feat(provider): pi adapter with native-event passthrough (Option D) (c-6)` and a body covering: Option D rationale, OneCLI removal, the four HIGH bug fixes from the audit, the inline-and-dedupe refactor.

---

## Task c-7: Register pi provider + add CLAUDE.providers/pi.md

**Files:**
- Modify: `container/agent-runner/src/providers/index.ts`
- Modify: `src/providers/index.ts`
- Create: `container/CLAUDE.providers/pi.md`

- [ ] **Step 1: Add registration imports**

In `container/agent-runner/src/providers/index.ts`, append `import './pi.js';`.
In `src/providers/index.ts`, append `import './pi.js';`.

- [ ] **Step 2: Create or verify CLAUDE.providers directory**

If `container/CLAUDE.providers/` doesn't exist in classroom (per the pre-pi audit), create it: `mkdir -p container/CLAUDE.providers`.

- [ ] **Step 3: Lift pi.md from personal**

Copy `/Users/admin/projects/nanoclaw_personal/container/CLAUDE.providers/pi.md` to `container/CLAUDE.providers/pi.md`. Read the fragment and remove any personal-specific references (Linda mentions, etc.) per the audit findings.

- [ ] **Step 4: Verify the fragment is composed into agent system prompts**

Check `src/claude-md-compose.ts` for the provider-fragment compose pipeline. If classroom doesn't have one (per the audit, it may not), add one: when an agent group's `container_configs.provider === 'pi'`, append `container/CLAUDE.providers/pi.md` content to the runtime system prompt.

- [ ] **Step 5: Commit**

Stage all three files and commit with subject `feat(provider): register pi + add pi.md fragment (c-7)`.

---

## Task c-8: End-to-end validation

- [ ] **Step 1: Build + test**

From `/Users/admin/projects/nanoclaw`:
1. `pnpm run build`
2. `pnpm test`
3. `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit`
4. `cd container/agent-runner && bun test src/providers/`

All clean.

- [ ] **Step 2: Rebuild the container image**

Run `cd /Users/admin/projects/nanoclaw && ./container/build.sh`

- [ ] **Step 3: Restart the classroom service**

Run:
```
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
sleep 5
tail -50 logs/nanoclaw.log
```

Expect clean boot, no startup errors.

- [ ] **Step 4: Create a test pi agent group**

Run:
- `ncl groups create --name "Pi Test" --folder pi-test`
- `ncl groups config update --id <new-id> --provider pi --model claude-sonnet-4-5`

- [ ] **Step 5: Wire to a messaging group + send a message**

Use the playground or Telegram to send a chat message routed to the new agent group. Confirm:
- Container spawns
- Pi handles the message
- Response comes back
- Trace panel in playground shows pi-native events (streaming text, tool calls if any, thinking blocks if the model uses them)

- [ ] **Step 6: Compare trace richness vs claude session**

Send the same message to an existing claude-backed agent group. Side-by-side compare trace panel output. Pi session should show streaming text in real time; claude session should still render its existing `tool_use`/`tool_result`/`model_call` shape.

- [ ] **Step 7: Tag the phase end**

Run:
- `git tag phase-c-complete-2026-05-25 -m "Phase C pi port with native events complete"`
- `git log catchup/phase-a-2026-05-25..HEAD --oneline`

---

## Self-Review checklist

- [ ] All commits build cleanly individually
- [ ] Full host test suite green
- [ ] Container test suite green
- [ ] Pi packages installed at exact version 0.75.4
- [ ] Pi smoke test gated by RUN_PI_LIVE=1 (doesn't fire by default)
- [ ] Test pi agent group spawns and responds
- [ ] Trace panel renders pi-native events for pi sessions
- [ ] Existing claude agent groups still render their current trace shape
- [ ] No regressions in security fixes from Phase A or DB migration from Phase B½
- [ ] HIGH bugs from `pi-personal-audit-2026-05-25.md` are fixed in this port (sessionsRoot, modelProvider, HTTP MCP bridge, error double-emit, async-generator wrapper)
- [ ] Tag `phase-c-complete-2026-05-25` set

## What this plan does NOT do

- Delete `claude.ts` or `codex.ts` — Phase D
- UI hardcoding cleanup beyond what's needed for pi to render — Phase D
- `class-codex-auth.ts` removal — Phase D
- Per-student pi auth configuration

## Cross-references

- Parent plan: `plans/classroom-upstream-catchup-2026-05-25.md`
- Prior plan: `docs/superpowers/plans/2026-05-25-phase-bhalf-container-configs-db.md`
- Audit: `plans/pi-personal-audit-2026-05-25.md` (HIGH bugs addressed in c-6 Step 5)
- Migration risk: `plans/pi-migration-gotchas.md` (Claude SDK continuation-baking — relevant during cutover)
- Sub-agent followup: `plans/pi-sub-agents.md` (later plan that builds on pi being live)
