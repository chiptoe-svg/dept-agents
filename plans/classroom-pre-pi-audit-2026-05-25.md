# Classroom Pre-Pi Audit — nanoclaw (gccourse) 2026-05-25

> **Audience:** Inputs to the unwritten `pi-classroom-port.md` and `trace-vocabulary-expansion.md` plans, and to any cleanup work the user wants to do before pi lands in classroom.
> **Method:** Four parallel sonnet agents reviewed (A) provider abstraction state + divergence from personal, (B) UI/agent-builder/class-* provider coupling, (C) trace pipeline + credential proxy contract, (D) tests + CLAUDE.md fragments + schema + dead code. ~30 minutes total wall-clock.
> **Audit target:** `/Users/admin/projects/nanoclaw` (the gccourse classroom install). Findings inform what to clean up in classroom *before* pi gets ported in.

---

## TL;DR — the surprising shape

**Classroom is architecturally ahead of personal in the trace + provider-event layer**, not behind. Classroom has a richer `ProviderEvent` type (with `tool_use`, `tool_result`, `model_call`, `compacted` metadata) and an actual `emitTraceToPlayground` pipeline. **Personal has none of that** — pi.ts was written against personal's stripped-down event shape.

**This means the two ProviderEvent schemas are mutually incompatible.** Pi.ts in personal emits `cost` and `partial_text` events that classroom's poll-loop has no handlers for; classroom's poll-loop expects `tokens`, `latencyMs`, `provider`, `model` fields on `result` that personal's shape doesn't carry. **You cannot copy pi.ts from personal to classroom and have it work** — even before considering OneCLI vs credential-proxy.

**Classroom has six independent UI/provisioning files hardcoding `{claude, codex, local}` as a closed set.** This isn't accidental — the same pattern recurs across the models tab, home tab, direct-chat dispatcher, student provisioning, model switcher, and JWT/account parsers. Adding pi requires surgical edits in all six.

**Good news:** the schema is genuinely clean (TEXT fields, zero CHECK constraints, zero enum constraints), and the auth-registry / classroom-provider-resolver backend chain is provider-neutral. The mess is concentrated in the UI/UX surface and in one architectural decision (event schema reconciliation).

**Honest revised effort estimate:** classroom pi port is **2-3 weeks**, not 1-2. The reconciliation work + UI surgery + dropping personal's OneCLI-isms moves the goalposts.

---

## HIGH priority — mess to clean up before pi port

### Structural / architectural

- **`container/agent-runner/src/providers/types.ts` — ProviderEvent shapes are incompatible between classroom and personal.** Classroom: rich `result` with `tokens`, `latencyMs`, `provider`, `model`; events include `tool_use`, `tool_result`, `model_call`, `compacted`. Personal: stripped `result: { text: string | null }`; adds `partial_text` and typed `cost` events. **Decision needed before porting:** pick the canonical schema. Recommended: classroom's richer base + add `partial_text` / streaming-text concept. Either way this is the first reconciliation, not a side concern.

- **`container/agent-runner/src/providers/types.ts:23-65` — `ProviderOptions` is missing five fields pi needs:** `hostMcpUrl`, `nanoclawSessionId`, `authMode`, `effort`, `modelProvider`. Pi's `getApiKeyAndHeaders` throws if `modelProvider` is undefined. These must be added to the interface before pi can be instantiated from `createProvider()`.

- **`src/class-student-provision.ts:161-168` and 261-263** — `makeContainerConfig` hardcodes `provider: 'codex'` and `provisionStudent` hardcodes `model: 'gpt-5.4-mini'` as the defaults for every student. **All students spawned via the add-student flow or class skeleton script come up as codex agents.** Pi as a provider for students is structurally impossible without changing this. (Likely also a class-day risk independent of pi — students currently can't be provisioned as Claude either.)

- **`src/model-switch.ts:32-39`** — `resolveEffectiveModel` is a hardcoded two-way branch: `provider === 'codex'` → env CODEX_MODEL or `'gpt-5.5'`; `provider === 'claude'` → env ANTHROPIC_MODEL or `'claude-sonnet-4-6'`; else `'(unknown)'`. **Pi sessions would resolve to `'(unknown)'` as their effective model**, silently propagating into container.json on provider-switch.

- **`src/channels/playground/api/direct-chat.ts:265-278`** — direct-chat dispatcher is closed: `codex|local → dispatchOpenAI`, `claude → dispatchAnthropic`, else **400 "doesn't support provider X yet"**. Pi would get 400 on every direct-chat call. This is an explicit reject of unknowns, not a missing entry.

### UI hardcodes (six places, all roughly the same pattern)

- **`src/channels/playground/public/tabs/home.js:730-733`** — `PROVIDERS` hardcoded array of two objects `[{id:'codex'}, {id:'claude'}]`. Drives both class-controls policy editor and Home tab "LLM Providers" card. Pi invisible to instructor and to students' connection UI.

- **`src/channels/playground/public/tabs/models.js:110-115`** — Status pills fetched only for `claude` and `codex` in a hardcoded `Promise.all` pair. Pi gets no status pill.

- **`src/channels/playground/public/tabs/models.js:119`** — Render loop iterates the literal array `['claude', 'codex', 'local']`. Pi's models section never renders.

- **`src/channels/playground/public/tabs/chat.js:197`** — Respawn-warning branch fires only when `provSel.value === 'claude'`, based on assumption that other providers re-read container.json per-turn. If pi behaves like claude (long-lived SDK process), model switches don't trigger the warning.

- **`src/provider-switch.ts:50-53`** — `PROVIDER_HINTS` hardcoded as `claude`, `codex`, `local`. `/provider` command reply doesn't mention pi. Not a blocker (any string accepted by `setProvider`), but pi is undiscoverable.

- **`src/channels/playground/api/provider-auth.ts:164-178`** — `extractAccountEmail` hardcodes `'claude'` and `'codex'` branches for JWT/account parsing. Pi gets `undefined` for the account display label (cosmetic, not fatal).

### Missing infrastructure

- **`container/CLAUDE.providers/` does not exist in classroom.** Personal has `claude.md`, `codex.md`, `pi.md` fragments. Classroom has zero provider-fragment infrastructure. Provider guidance lives nowhere in `container/CLAUDE.md` (only 6 lines of common content). Pi's fragment would be the first addition to this pattern in classroom — meaning the whole compose pipeline needs to be built or ported.

- **`container/agent-runner/src/providers/claude.ts`** — no `maybeRotateContinuation()` implementation. Personal added the full transcript-rotation logic. Classroom is missing this. Not a pi blocker per se but a general regression.

---

## MEDIUM priority — fix during port

### Mechanical UI/catalog updates

- **`src/model-catalog.ts:9`** — `ModelEntry.provider` typed as `'claude' | 'codex' | 'opencode' | 'ollama' | string`. The `| string` escape hatch saves it at runtime but pi loses type discrimination. Add `'pi'` literal.

- **`src/model-catalog.ts:211-228`** — Catalog refresh logic filters and adds auto-discovered entries only for `provider === 'codex'`. Pi models discovered from a live `/v1/models` endpoint would never be auto-curated.

- **`src/channels/playground/api/models.ts:19-21`** — `DiscoveredModel.provider` typed as `'claude' | 'codex' | 'local'`. Pi discovered models fail the type.

- **`src/channels/playground/api/models.ts:317`** — `handleAutoFillCatalog` handles only `claude`, `codex`, `local` explicitly; pi falls through with `{suggestion: null, source: 'no-source-for-provider'}`.

- **`src/channels/playground/api/usage.ts:116`** — `isOpenAi` classification hardcodes `'codex' || 'openai' || 'openai-custom'`. Pi needs a decision: Anthropic wire format or OpenAI for token accounting.

- **`src/channels/playground/public/tabs/models.js:155-156`** — Empty-grid hint text hardcoded: `ANTHROPIC_API_KEY` for claude, `OPENAI_API_KEY` for anything else. Pi would display wrong key name.

- **`src/channels/playground/public/tabs/home.js:389-393`** — `renderUsageCard` hardcodes `?providers=codex` in the fetch URL with comment "Strip claude + local rows so the rollup matches platform.openai.com". Pi excluded from student usage display and class cost rollup.

- **`src/channels/playground/public/tabs/home.js:440`** — `AUTH_LABEL` object has keys for `api-key`, `oauth`, `claude-code-oauth` only. New auth modes need entries here.

### Backport from personal

- **`container/agent-runner/src/providers/claude.ts:352`** — Classroom passes `settingSources: ['project', 'user']`; personal passes `['project', 'user', 'local']`. The `'local'` source enables per-machine settings.local.json overrides. Backport this.

- **`container/agent-runner/src/providers/codex.ts:402-492` + `runOneTurn` handler** — Classroom has full trace translation (~90 LoC + ~130 LoC notification handler). Personal's codex is stripped. Worth verifying the personal/classroom codex divergence isn't causing other regressions.

### Test coverage

- **`container/agent-runner/src/providers/factory.test.ts:8-18`** — Does not enumerate codex (covered in `codex.factory.test.ts:54` separately). Adding pi widens this gap. Single test file should cover all registered providers.

- **`container/agent-runner/src/providers/claude.test.ts`** — Mislabeled. 3 tests test only `ProviderEvent` shape for provider field `'claude'`. No `ClaudeProvider` class behavior is tested. **Classroom has effectively zero coverage of ClaudeProvider's actual behavior** — surfacing pi will share this gap.

- **`container/agent-runner/src/providers/codex-app-server.test.ts`** — `writeCodexConfigToml` tests only cover `activeProvider: 'codex'` and `activeProvider: 'local'`. Pi config-write path needs new describe block.

### Credential proxy gap

- **`src/credential-proxy.ts` has four explicit provider routes**: anthropic (default), openai (`/openai/*`), omlx (`/omlx/*`), google (`/googleapis/*`). Pi-routable providers outside these four (DeepSeek, Groq, xAI, OpenRouter, etc.) would not be intercepted by the proxy. **Pi's multi-provider promise narrows in classroom to what the proxy supports.** Either add proxy routes or document the constraint.

- **The classroom credential proxy injection is HTTP-layer**, not container-env-resolver. Personal's `pi-auth.ts` resolves credentials inside the container per-turn via `getApiKeyAndHeaders`. **In classroom, pi-auth.ts should be MOSTLY REMOVED** — the proxy injects credentials at the wire; pi.ts should just not pass `getApiKeyAndHeaders` and let the SDK use placeholder keys that the proxy swaps. This is a medium refactor.

---

## LOW priority — note for posterity

- **`container/agent-runner/src/providers/index.ts:5-7`** — barrel imports only `claude`, `codex`, `mock`. Pi registration appends one import.
- **`src/providers/index.ts:8`** — host barrel imports only `codex`. Pi host-side container config (if needed) appends one import.
- **`container/agent-runner/src/providers/codex.ts:241-251`** — `codexEffort` plumbing is already in place for the broader effort mechanism; pi can use it when ready.
- **`container/agent-runner/src/poll-loop.ts:444-449`** — `handleEvent` switch correctly handles `tool_use/tool_result/model_call` — pi would need to emit these in classroom's schema to light up the trace panel.
- **`src/claude-md-compose.ts:61`** — one `TODO (shared-source refactor): respect container.json skill selection`. Unrelated unfinished work, but worth tracking.

---

## Cross-cutting themes

**1. Personal and classroom diverged in opposite directions.**
- Personal: added pi, added OneCLI integration, added some optional Provider methods, **stripped down ProviderEvent** to focus on streaming-text + cost events.
- Classroom: added image inputs, added per-group skill filtering, added auth-registry, added agent-builder, added classroom-provider-resolver, **richer ProviderEvent** with full tool/cost metadata.
- The divergence is two genuinely different design pressures (personal optimizing for pi's event model; classroom optimizing for playground trace UI). Reconciliation is the first port task.

**2. UI provider hardcoding is the systemic pattern, not the exception.**
Six independent files have closed `{claude, codex, local}` enumerations. This isn't accidental cruft — it's the codebase's actual convention for "where providers are listed." Adding pi mechanically means touching all six. There's no single registration point that propagates a new provider through the UI.

**3. Backend is genuinely provider-neutral.**
The schema, the auth-registry, the classroom-provider-resolver, the container-runner, the credential-proxy routing logic — all of these key on arbitrary provider IDs. Pi-the-backend slots in cleanly. Pi-the-UI-citizen takes work.

**4. Classroom has no `container/CLAUDE.providers/` infrastructure at all.**
Personal has this pattern (3 fragments). Classroom needs the compose pipeline + fragments built or ported. Provider-neutral content from personal's claude.md should land in classroom's base CLAUDE.md as part of this work.

**5. Tests are thin on both sides.**
Personal pi tests have gaps (OAuth refresh, rotation, error paths). Classroom claude.test.ts is mislabeled and tests nothing about ClaudeProvider behavior. Codex factory tests are split across two files. Neither install has solid integration-test coverage for the playground's provider-touching paths.

---

## Recommended sequence (revised)

### Pre-port cleanup in classroom (1-2 weeks)

1. **Decide on canonical ProviderEvent schema.** Recommend: classroom's richer base + add `partial_text` for streaming text + decide whether to keep typed `cost` event or fold into `result`. This decision unblocks the rest.

2. **Add missing `ProviderOptions` fields to classroom**: `modelProvider`, `authMode`, `hostMcpUrl`, `nanoclawSessionId`, `effort`. ~30 LoC change. Defaults so existing claude/codex still work.

3. **De-hardcode the six UI/provisioning files.** Refactor each from `{claude, codex, local}` literal to consume a provider registry. Mechanical but spread across 6 files. ~3-4 days.

4. **Fix `makeContainerConfig`** in `class-student-provision.ts` to not always provision `codex`. Either accept a provider parameter or default-by-config. Independent of pi — current behavior is wrong for any non-codex classroom setup.

5. **Fix `resolveEffectiveModel`** in `model-switch.ts` to handle arbitrary providers (consult model-catalog instead of two-way hardcoded branch).

6. **Backport `maybeRotateContinuation` from personal to claude.ts.** Independent of pi; classroom has a transcript rotation gap.

7. **Create `container/CLAUDE.providers/` structure** in classroom. Stub claude.md (move provider-neutral content to base), stub codex.md (same), prepare for pi.md.

### Port pi to classroom (1-1.5 weeks, after pre-port cleanup)

8. **Port pi.ts adapted to classroom's event schema.** Drop the `cost` and `partial_text` emissions; emit `tool_use`, `tool_result`, `model_call`, `compacted` per classroom's convention. Use rich `result` event with tokens/latency.

9. **Drop pi-auth.ts entirely. Don't pass `getApiKeyAndHeaders` to AgentHarness.** The classroom credential proxy injects credentials at the wire. Pi just consumes placeholder keys.

10. **Adapt pi.ts container env requirements** to match classroom's credential-proxy injection contract. Pi's `modelProvider: 'anthropic'` path uses `ANTHROPIC_API_KEY` placeholder (api-key mode) or `CLAUDE_CODE_OAUTH_TOKEN` (oauth mode), whichever the agent group is configured for.

11. **Add pi-spec.ts** in `src/providers/` for the auth-registry / Home tab connect flow.

12. **Add pi to all six de-hardcoded UI spots.** Now mechanical because step 3 made them registry-driven.

13. **Add pi.md to `container/CLAUDE.providers/`** with classroom-relevant content.

14. **Add proxy routes** for non-anthropic/openai pi-routable providers IF they're in scope for classroom (deepseek, groq, etc.). Otherwise document the constraint and limit pi's `modelProvider` to {anthropic, openai-codex} in classroom.

### Bonus / nice-to-have (during or after port)

15. **Fix factory.test.ts** to enumerate all registered providers.
16. **Fix claude.test.ts mislabel** — write actual ClaudeProvider behavior tests.
17. **Add CLAUDE.providers compose tests** if the pattern wasn't already tested in personal.

---

## Cross-references

- **`pi-personal-audit-2026-05-25.md`** — pre-existing audit of personal pi code. Findings there about OneCLI coupling, hardcoded paths, test gaps inform what to STRIP when porting (drop OneCLI; use proxy; rewrite tests).
- **`pi-sub-agents.md`** — sub-agent strategy. Still applies but depends on classroom port landing first.
- **`pi-migration-gotchas.md`** — Claude SDK continuation-baking. Applies during the classroom port too.
- **`classroom-cost-guardrails.md`** — runaway meter plan. Coordinated rollout: cost guardrails benefit from pi's per-turn cost data, but that data has to be emitted in classroom's chosen event schema (step 1 above).
- **`master.md`** — classroom roadmap; consider adding a "pre-pi cleanup" phase before the eventual pi port.
