# Pi Audit Findings — nanoclaw_personal (2026-05-25)

> **Audience:** Inputs to the unwritten `pi-personal-switchover.md`, `pi-classroom-port.md`, and `trace-vocabulary-expansion.md` plans.
> **Method:** Four parallel sonnet agents reviewed (A) AgentProvider contract honesty, (B) trace pipeline kludges, (C) pi-side code + OneCLI patterns, (D) test coverage + CLAUDE.md fragments. ~30 minutes total wall-clock.
> **Verdict:** The pi integration is structurally sound but has ~6 real production risks that should be fixed before pi-only switchover, plus a substantial cleanup tail that's worth doing during the port to classroom rather than after.

---

## TL;DR

The `AgentProvider` interface itself is portable — pi conforms genuinely. The problems live in the surrounding infrastructure: hardcoded paths, OneCLI assumptions in unexpected places, silent event drops in the poll-loop, and missing test coverage for the auth paths that fail most in production. The pi.ts container-side file (454 LoC) is generally well-structured but carries two load-bearing assumptions (OneCLI as credential gateway, `/workspace/` mount layout) that aren't abstracted. None of this blocks pi from working today — it blocks the switchover from being trustworthy.

**Audit target:** `/Users/admin/projects/nanoclaw_personal` (NOT the gccourse classroom — classroom has no pi files yet). Findings inform what to fix in personal before/during the pi-only switchover, and what to carry forward when porting pi to classroom later.

**Phase 0 (verification) result, 2026-05-25:** The most-alarming HIGH finding ("every event emitted twice") was REFUTED on careful re-read. Real issue is narrower: error events double-emit (5-min fix) plus the wrapping async-generator-with-no-yields is structurally confusing (30-LoC cleanup). Other HIGH findings stand.

---

## HIGH priority — fix before pi-only switchover

### Bug-grade

- **`pi.ts:172` — hardcoded `/workspace/pi-sessions` with no rotation.** The path isn't mounted by the host but happens to persist because it falls under the `/workspace` bind mount. No `maybeRotateContinuation` for pi means jsonl files grow without bound. Worse, the legacy continuation migration in `session-state.ts` (`migrateLegacyContinuation`) hands the old `claude|<id>` format to pi's `parseContinuation`, which throws `"Invalid Pi continuation payload"`. **Cold-resume corruption risk on the Linda → pi flip we discussed.**

- **`pi.ts:223-231` — `getApiKeyAndHeaders` throws if `modelProvider` undefined.** `index.ts:93-101` reads `modelProvider` from `container.json`. Any agent group currently configured for `claude` will have no `modelProvider` field, and the first pi turn after switching throws before the first token. **The switchover runbook must update `container.json` before flipping `provider`.**

- **`pi.ts:191-195` — HTTP MCP bridge intent is silently dead.** `createPiMcpBridge` is constructed with `hostMcpUrl: options.hostMcpUrl` and `sessionId: options.nanoclawSessionId`, but `index.ts` never passes these fields to `createProvider()`. The `hasHttpNanoclaw` guard always evaluates false; pi gets MCP access only via stdio child-process transports. Functionally working but the session-correlation feature the HTTP bridge was designed for is dormant.

### Data-loss-grade

- **Poll-loop drops `cost` and `partial_text` events.** Pi emits these (pi.ts:53-68 for cost, pi.ts:268 for partial_text). Poll-loop's `handleEvent` (poll-loop.ts:467-484) has no case for either. **Real cost data is being computed and discarded** — never reaches outbound.db or the host. Streaming text deltas are also dropped (no live trace updates for pi).

### Test-coverage-grade (blocks confidence, not function)

- **OAuth refresh mid-session is untested.** `pi-auth.test.ts` covers reading valid tokens and JWT exp decoding but not the actual refresh round-trip against `auth.openai.com`. This is the primary auth failure mode during long classroom sessions.

- **Continuation parsing / cross-session resume has no tests.** `claude.rotate.test.ts` has four dedicated rotation tests; pi has zero. The same gap as the `pi.ts:172` issue above, but on the test side.

- **`pi.factory.test.ts` is a 2-line existence check.** Compare `codex.factory.test.ts` which covers `isSessionInvalid`, `supportsNativeSlashCommands`, import cycles, YAML chomping, skill ordering. Pi-factory test coverage is notably thinner.

---

## MEDIUM priority — fix during switchover

### Will surprise operators on day 1 of pi-only

- **Long bash tools get killed at 60s in pi.** `claude.ts:161-189` writes `container_state.current_tool` so `host-sweep.ts:223-225` extends the stuck-tolerance window. Pi has no equivalent — emits `progress` events instead. Any Pi agent running a 5-minute shell command gets reaped by the sweep.

- **No `maybeRotateContinuation` for pi.** Jsonl session files grow without bound. Eventually cold-resume hits the same "container killed before first reply" failure mode the optional method was designed to prevent. Linked to the `pi.ts:172` finding.

- **Init event fires AFTER harness construction (~3s skills loading).** Claude emits `init` as the first SDK event so poll-loop can persist the continuation early. Pi crashes during harness construction lose the session.

- **`/compact` and similar slash commands are echoed to pi as literal user messages.** `formatMessagesWithCommands` only routes slash commands when `supportsNativeSlashCommands = true`. Pi sets this false. Pi's compaction is autonomous (auto-compact at 70%), so the user-typed `/compact` does nothing useful — it just becomes part of the conversation.

### Pi.ts error-emit and architectural cleanup (Phase 0 verified 2026-05-25)

- **`pi.ts:330-338` + `pi.ts:359-366` — error events emitted twice on any provider failure.** Verified by direct reading. Trace: inner `harness.prompt(...)` failure → catch at 330 pushes `{type: 'error', ...}` → re-throws at 338 → throw escapes through the outer try/finally blocks → IIFE at 354 catches the throw → pushes another `{type: 'error', ...}` at 361. Poll-loop receives two error events per failure. **Annoying, not corrupting.** Fix: pick one of the two emission sites and delete the other. ~5-minute change.

- **`pi.ts:169-352` + `pi.ts:354-370` — async generator wrapper has no `yield` statements; the IIFE iterates it but the for-await body is unreachable.** The Agent A audit misread this as "every event emitted twice" because the structure looks like a translation pipe but isn't. Verified: zero yields in the generator body; all events flow through `queue.push(...)`. The IIFE exists only to (a) kick the generator into running, (b) catch throws, (c) call `queue.end()`. This works but is genuinely confusing — the structural reason both audit agents and human readers misread the code. **Cleanup opportunity, not a bug:** flatten the generator body into the IIFE for ~30 fewer LoC. Do during Phase 1 fixes, not separately.

### Classroom-port debt

- **`web-search.ts` hardwired to OneCLI HTTPS_PROXY.** No `X-Subscription-Token` header sent; the comment explicitly relies on OneCLI's gateway injection. The 401 error hint tells the user to `onecli secrets create`. **In classroom (credential-proxy), `web_search` always 401s with no recovery path.** Needs credential-injection abstraction or explicit Authorization header from env.

- **`src/providers/pi.ts:5-58` — OneCLI-specific NO_PROXY bypass.** `NO_PROXY=chatgpt.com,auth.openai.com` exists because OneCLI rejects unmatched hosts. Credential-proxy doesn't have this problem. Misleading at minimum; would suppress routing if the classroom proxy sits at a different hop.

- **`pi-auth.ts:11` PI_AUTH_FILE hardcoded with unused override mechanism.** `getPiAuthApiKey` accepts `authPath` as second argument but `pi.ts:227` never passes it. Classroom port can't change the path without source edits.

- **`pi-model.ts:11-15` hardcoded aliases `haiku → claude-haiku-4-5`, `sonnet → claude-sonnet-4-5`.** Will silently fail or use stale models when Anthropic releases new point versions. No override mechanism. Contrast claude.ts which passes `model` through directly.

- **`pi-auth.ts:20-50` `PLACEHOLDER_ENV_BY_PROVIDER` anthropic → `ANTHROPIC_AUTH_TOKEN` is OneCLI-specific.** Credential-proxy injects `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. **If a classroom install sets `modelProvider: 'anthropic'`, `getPiAuthApiKey` will look for `ANTHROPIC_AUTH_TOKEN`, find the placeholder, and return it as the real key — bypassing credential-proxy entirely.** Silent auth disaster in classroom.

- **`pi.ts:244-256` Codex-specific tool_choice hook in pi container.** A `before_provider_payload` hook forces `tool_choice: 'required'` for gpt-5.x-codex behavior. Belongs in a codex-specific file; pi shouldn't carry Codex branching.

### Test coverage parity

- **Rate-limit / 429 handling untested.**
- **Image input wiring untested.** Same gap I flagged earlier in our vision-support discussion — pi-ai supports images, pi-agent-core's `prompt()` accepts them, but nothing in personal exercises the path.
- **MCP tool execution errors untested.** Bridge tests cover happy path only.
- **Model switching mid-session untested.**
- **HTTP MCP bridge transport-error path untested.**

### Trace pipeline (informs the trace-expansion plan)

- **Translator extraction is clean for claude/codex but blocked for pi.** Claude's `translateEvents()` (lines 431-459, ~29 LoC) and codex's `runOneTurn()` (lines 288-407, ~80 LoC) are already self-contained generators with clean input/output types — verbatim lifts. Pi's translation is split across three sites (subscribe callback, prompt await, pre-loop init push), interleaved with session management and `createEventQueue` concurrency plumbing. **Pi extraction requires rethinking queue-per-query structure or introducing a translation adapter around `AgentHarness`.** Trace expansion in pi-only future is harder than it looks.

### CLAUDE.md fragment reorganization

- **`claude.md` content that should MOVE to base before phasing out Claude:** lines 9-11 (channel I/O via in-container MCP tools, scheduling / agent-to-agent / self-mod as MCP tools, memory protocol). These are NanoClaw architectural invariants, not Claude-SDK-specific. **Pi agents currently get NO equivalent guidance** — they have only the 13 lines in pi.md.

- **`pi.md:9` "one delivery channel per reply" should move to base.** Architectural constraint, not pi-specific.

- **`pi.md:13` "parity with Codex" rationale will mislead readers post-Codex-removal.** Edit when Codex leaves.

---

## LOW priority — note for posterity

- `pi.ts:30` `AUTO_COMPACT_THRESHOLD = 0.70` hardcoded vs claude's env var override.
- `pi-tools/web-search.ts:6` comment references Linda by name — personal-coupled.
- `pi-mcp-bridge.ts:43` client name `'nanoclaw-pi-bridge'` hardcoded — harmless, but signals lack of portability review.
- `src/providers/pi.ts:47` known TODO about chatgpt.com OneCLI gap.

---

## Cross-cutting themes

**1. OneCLI is non-uniformly integrated.** Claude.ts has zero OneCLI references. Codex.ts has zero OneCLI references. Pi.ts/pi-auth.ts/web-search.ts depend on OneCLI as an active HTTPS proxy. **Pi is the ONLY provider where swapping OneCLI for credential-proxy requires code changes, not just env var changes.** This is the single biggest classroom-port debt.

**2. The AgentProvider contract is honest.** Genuinely portable interface; pi conforms cleanly at the TypeScript level. The problems are infrastructure-shaped, not interface-shaped — meaning they're fixable in place without redesigning the contract.

**3. Pi has richer events than the contract surfaces.** `cost` and `partial_text` are in `ProviderEvent` but unhandled in poll-loop. Trace expansion has to be a contract change (add handlers), not just a file relocation.

**4. Test coverage is uneven.** Pi tests are notably thinner than claude/codex tests; the gaps cluster around the failure modes most likely to fire in production (OAuth refresh, continuation handling, error paths).

**5. CLAUDE.md fragments are mis-scoped.** Provider-neutral guidance is trapped in claude.md and codex.md. Pi agents are flying blind on architectural invariants until those fragments are reorganized.

---

## Recommended sequence

### Phase 0 — Bug verification (DONE 2026-05-25)

1. ✅ **`pi.ts:354-370` "every event emitted twice" — REFUTED.** The async generator has no `yield` statements; the IIFE's for-await loop body is unreachable. No event-doubling on success paths. See "Pi.ts error-emit and architectural cleanup" under MEDIUM for the real (much narrower) issue: error events double on any provider failure (5-min fix), plus a 30-LoC structural cleanup opportunity.
2. ⏳ **Outstanding:** audit `outbound.db.session_state` for any `cost` data on pi sessions to confirm whether the silent-drop is real or whether there's a path I missed. Quick `pnpm exec tsx scripts/q.ts data/v2-sessions/<id>/outbound.db "select session_state from session_state limit 5"` would settle it.

### Phase 1 — HIGH-priority fixes (3-5 days)

3. Fix `pi.ts:172` sessionsRoot — make path configurable via env, add cleanup hook.
4. Fix `pi.ts:223-231` — fall back to a sane default `modelProvider` rather than throw, or guard at switchover time via doctor command.
5. Wire `hostMcpUrl` and `nanoclawSessionId` through `index.ts → createProvider()` so the HTTP MCP bridge isn't dead.
6. Add `cost` and `partial_text` cases to `handleEvent` in poll-loop.ts. (May expand into the broader trace-vocabulary work — coordinate with that plan.)
7. Add tests for OAuth refresh mid-session, continuation parsing, MCP tool errors, model switching.

### Phase 2 — Easier-switching infrastructure (1 week, overlaps with the earlier "what to add in personal" recommendation)

8. Build `ncl groups reset <id>` and `ncl groups doctor <id>`. Doctor would catch the `modelProvider` undefined issue (HIGH #2) before the first turn.
9. Add `// CLASSROOM-DELTA:` comment markers wherever a personal-specific choice is made.

### Phase 3 — Classroom-port debt (during the classroom port, not before)

10. Abstract `CredentialResolver` in pi-auth.ts. Lets classroom inject credential-proxy resolver without modifying pi-auth.
11. Move `web-search.ts` to header-based auth as an alternative to OneCLI proxy.
12. Move provider-neutral guidance from claude.md / codex.md to base `container/CLAUDE.md`.
13. Move Codex-specific tool_choice hook (`pi.ts:244-256`) out of pi container into a codex-bridge file (or delete entirely when Codex is phased out).

### Phase 4 — MEDIUM and LOW polish (during or after classroom port)

14. Implement `maybeRotateContinuation` for pi.
15. Add `container_state.current_tool` writes to pi for long-tool sweep tolerance.
16. Make `AUTO_COMPACT_THRESHOLD` env-configurable.
17. Edit pi.md content per the reorganization findings.

---

## Cross-references to other plans

- **Phase 0 + Phase 1 fixes 5, 6** integrate with `trace-vocabulary-expansion` (not yet written)
- **Phase 2 infrastructure** matches the "What to add in personal to make classroom port easier" discussion
- **Phase 3 OneCLI abstraction** is the structural prerequisite for `pi-classroom-port` (not yet written)
- **HIGH bug #1** (`pi.ts:354-370` double-emit) — if confirmed, may explain runtime symptoms not yet diagnosed in personal. Worth checking against any "Linda double-responded" or "cost tracking looks 2x" reports.
- **`pi-migration-gotchas.md` 2026-05-25 entry** (Claude SDK system-prompt-baked-at-init) — separate issue, not in this audit's scope.
