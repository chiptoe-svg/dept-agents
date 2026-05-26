# Classroom → Upstream Catch-Up Diff — 2026-05-25

> **Audience:** Inputs to the unwritten `classroom-pi-only-catchup.md` plan. Captures what to bring forward from upstream main into classroom, what becomes deletable when claude/codex are removed, and the two big architectural decisions that gate the work.
> **Method:** Four parallel sonnet agents diffed `/Users/admin/projects/nanoclaw` (v2.0.46, classroom) against `/tmp/nanoclaw-upstream` (v2.0.70, upstream main). OneCLI deltas explicitly out of scope; classroom stays on credential-proxy.
> **End state:** Pi is the only agent harness in classroom. Claude SDK and Codex providers both deleted. Pi handles ChatGPT subscription via `openai-codex` routing and Anthropic via `anthropic` routing internally.

---

## TL;DR

**The catch-up is moderate, not huge.** Most of upstream's evolution beyond OneCLI is small, independent items: a transcript-rotation guard, an `effort` field, an `onWake=1` message-delivery flag, a multi-install slug, security fixes for approval flows, and a handful of regression tests. About **15 items worth bringing forward**, almost all OneCLI-independent.

**Two big architectural decisions gate everything:**

1. **`container_configs` DB migration** — upstream moved container config from `groups/<folder>/container.json` files into a SQLite table (migration 014 upstream). Several worthy improvements (self-mod respawn, `ncl groups config update` verbs) depend on this. Classroom's credential-proxy currently reads `container.json` at container spawn time. Adopting the DB migration is the right direction but is a real structural lift that touches container-runner, group-init, self-mod/apply, and the ncl groups CLI.

2. **`ProviderEvent` schema** — classroom carries rich event metadata (`tokens`, `latencyMs`, `provider`, `model` on `result`; plus `tool_use`, `tool_result`, `model_call`, `compacted` event variants). Upstream stripped all of this. The classroom playground trace panel *depends* on these events being emitted. Pi (in personal) doesn't emit them either. Decision: keep classroom's richer schema and have pi emit it, or adopt upstream's slim schema and lose the trace panel features.

**Migration version collision** between classroom and upstream needs handling (classroom 014 = `agent-model`, upstream 014 = `container-configs`).

**The bulk of the actual code reduction comes from deleting Claude SDK and Codex** — far more files get deleted than added. The catch-up itself is mostly subtractive plus a handful of additive items.

**Honest effort estimate:** 2-3 weeks for the catch-up + pi port, **assuming you skip the container_configs DB migration**. Adopting the DB migration adds another 1-2 weeks (touches enough files that the testing burden is real).

---

## BRING FORWARD — Items to lift from upstream

### Correctness / safety fixes (OneCLI-independent, high value, mostly small)

| Item | File:line | Why |
|---|---|---|
| `maybeRotateContinuation?(continuation, cwd)` on AgentProvider interface | `container/agent-runner/src/providers/types.ts:31` | Guards cold-resume OOM when `.jsonl` grows large. Pi has the same vulnerability once it's sole provider |
| `maybeRotateContinuation` implementation | `container/agent-runner/src/providers/claude.ts:~252` | Pair with the interface; rotates oversized/aged transcripts aside before resume |
| `claude.rotate.test.ts` | `container/agent-runner/src/providers/claude.rotate.test.ts` | 4-case bun test; the only coverage for rotation logic |
| `effort?: string` on `ProviderOptions` | `container/agent-runner/src/providers/types.ts:47-52` | Reasoning effort knob (low/medium/high/xhigh/max); provider-neutral; pi will want this for Claude extended thinking |
| `isCorruptionError()` + `CORRUPTION_STREAK_EXIT = 10` + streak-counter/exit logic | `container/agent-runner/src/poll-loop.ts:27-43` | Detects SQLite cross-mount page-cache corruption (virtiofs/gRPC-FUSE) and exits cleanly so host-sweep respawns. Classroom would loop indefinitely otherwise |
| `isFirstPoll` flag on `getPendingMessages` | `container/agent-runner/src/poll-loop.ts:107-111` | Used for deferred-message-on-startup handling |
| Unwrapped-output `<system>` nudge | `container/agent-runner/src/poll-loop.ts:303-308, 380` | Auto-nudges the model when it forgot to wrap output in `<message to>` blocks. Removes classroom's bare-text single-destination fallback |
| `onExit?: () => void` callback on `killContainer` | `src/container-runner.ts:193` | Lets self-mod immediately respawn without waiting for host-sweep tick |
| `onWake?: 0 \| 1` field on `writeSessionMessage` + idempotent `ALTER TABLE messages_in ADD COLUMN on_wake` | `src/db/session-db.ts:121-130, 327-330` | First-poll-only delivery. Paired with `onExit` callback for clean self-mod respawn semantics |
| `container-restart.ts` (whole file) + test | `src/container-restart.ts` | `restartAgentGroupContainers()` helper. Without it, `ncl groups restart` errors |
| `install-slug.ts` (whole file) | `src/install-slug.ts` | Per-checkout slug for launchd label, systemd unit, docker image base. Avoids name collision on multi-install hosts |
| Image build timeout 300s → 900s | `src/container-runner.ts:502` | Simple constant change; tripled to handle larger images |

### Security fixes (bring forward regardless of pi work)

| Item | File:line | Why |
|---|---|---|
| Colon-prefix safety in `handleSenderApprovalResponse` | `src/modules/permissions/index.ts:233-237` | Handles Teams-style `29:xxx` IDs that already contain a colon |
| `hasAdminPrivilege` check in `handleChannelApprovalResponse` | `src/modules/permissions/index.ts:441-447` | Currently an approver for group A could wire any group B they don't control. Security gap |
| `approverId` passed to `buildAgentSelectionOptions` | `src/modules/permissions/index.ts:357` | Pairs with above — filter the list to only groups the approver controls |

### Test infrastructure (small additions, useful coverage)

| Item | File | Why |
|---|---|---|
| `src/cli/transport-errors.ts` + `.test.ts` | (new file) | Formats ENOENT/ECONNREFUSED into "is the host running?" with correct launchd/systemd label |
| `src/cli/dispatch.test.ts` | (new file) | Unit tests for dispatch layer; classroom has none |
| `src/cli/resources/groups.test.ts` | (new file) | Regression test for #2525 (cascading-delete FK constraint bug) |
| `src/cli/resources/destinations.test.ts` | (new file) | Regression test for #2465 (approval-path hydration of every active session's inbound.db) |

### Cascading-delete fix for `ncl groups delete`

| Item | File:line | Why |
|---|---|---|
| `customOperations.delete` handler | `src/cli/resources/groups.ts:0-200` | Bug fix #2525: generic DELETE violates FK constraints when group has sessions/destinations |

---

## SKIP — OneCLI-coupled changes (deliberately not brought forward)

For situational awareness only:

- `src/container-runner.ts` OneCLI import + `applyContainerConfig` call (replaces classroom's credential-proxy env injection block)
- `src/providers/claude.ts` host-side (OneCLI auth wiring)
- `src/config.ts` OneCLI URL/key constants
- Comments referencing OneCLI throughout `src/delivery.ts`, `src/host-sweep.ts`, `src/approvals/*`

---

## SKIP DECISION — Container_configs DB migration (the big architectural delta)

Upstream moved container config from `groups/<folder>/container.json` files into a SQLite table:

- New migration `014-container-configs.ts` creates the `container_configs` table (provider, model, effort, image_tag, assistant_name, max_messages_per_prompt, skills, mcp_servers, packages_apt/npm, additional_mounts, updated_at)
- New migration `015-cli-scope` adds `cli_scope` column
- New `src/db/container-configs.ts` module with `getContainerConfig`, `updateContainerConfigScalars`, `updateContainerConfigJson`, `materializeContainerJson`
- New `src/backfill-container-configs.ts` for one-time seeding from legacy disk files
- `src/container-runner.ts`, `src/group-init.ts`, `src/modules/self-mod/apply.ts` all rewritten to use DB instead of filesystem

**Why it matters:** Several BRING FORWARD items (especially self-mod respawn semantics in apply.ts) depend on this DB layer. Without it, those items can't be cleanly lifted.

**Why it's hard for classroom:** Classroom's credential-proxy reads `container.json` at container spawn time. Adopting the DB migration requires changing the spawn path too, which cascades.

**Recommendation:** **Skip for v1 catch-up.** Adopt the BRING FORWARD items that don't depend on it (most of them). Note the gap and revisit if/when the next refactor cycle makes it cheap.

---

## BECOMES DELETABLE (post pi-only)

### Whole files

- `container/agent-runner/src/providers/claude.ts`
- `container/agent-runner/src/providers/claude.test.ts`
- `container/agent-runner/src/providers/codex.ts`
- `container/agent-runner/src/providers/codex-app-server.ts`
- `container/agent-runner/src/providers/codex-app-server.test.ts`
- `container/agent-runner/src/providers/codex.factory.test.ts`
- `src/providers/codex.ts`
- `src/providers/codex-spec.ts`
- `src/providers/codex.test.ts`
- `src/providers/claude-spec.ts`
- `src/providers/auth-registry.ts` and `auth-registry.test.ts` *(unless pi adopts a similar pattern — see Needs Decision)*
- `src/class-codex-auth.ts` (entire file — codex-only credential pool)
- `src/codex-auth-switch.ts`
- `src/host-codex-api-key.ts`
- `src/model-catalog-refresh.ts` (codex-specific OpenAI doc fetcher)
- `src/admin-handlers/codex-auth.ts`
- `src/admin-handlers/provider.ts` *(if pi-only obsoletes the `/provider` Telegram admin command)*

### Lines / blocks within files

- `container/agent-runner/src/providers/index.ts:5-6` — `import './claude.js'` and `import './codex.js'`
- `container/agent-runner/src/poll-loop.ts:168-172` — `imagePaths` extraction block in provider.query call *(if pi handles images via content blocks rather than imagePaths)*
- `src/providers/index.ts:8` — `import './codex.js'`
- `src/index.ts:19, 75` — `codex-spec` and `class-codex-auth` imports
- `src/channels/playground/public/tabs/home.js:730-733, 728-930` — `PROVIDERS = [{id:'codex'}, {id:'claude'}]` array and the entire `renderProvidersCard`/`wireProviderRow` block
- `src/channels/playground/public/tabs/home.js:439, 473, 488, 518` — `ALL_AUTH`, `AUTH_LABEL`, usage rows referencing codex/claude
- `src/channels/playground/public/tabs/models.js:19-38, 110-115, 119` — static HTML sections + parallel pill fetches + render loop hardcoded for codex/claude/local
- `src/channels/playground/api/direct-chat.ts:265-278` — closed three-way dispatcher
- `src/channels/playground/api/provider-auth.ts:163-178` — `extractAccountEmail` with codex/claude branches
- `src/class-student-provision.ts:166, 261` — `provider: 'codex'` and `agent_provider: 'codex'` hardcodes (replace with `'pi'`)
- `src/model-switch.ts:32-39` — two-way `codex`/`claude` branch in `resolveEffectiveModel` (replace with pi-aware resolution)
- `src/provider-switch.ts:50-53` — `PROVIDER_HINTS` array (collapse to pi-only)
- `src/model-catalog.ts:100-165` — all `provider: 'codex'` entries in BUILTIN_ENTRIES (and any claude entries you want to drop)
- `src/db/session-db.ts:17-37` — `addColumnIfMissing` block for `tokens_in/out/latency_ms/provider/model` on messages_out *(if you simplify to upstream's slim schema)*

### Test files made redundant

- All codex.* tests in container/agent-runner
- All codex tests in src/providers
- Anything in playground tests that asserts codex/claude as expected provider strings

### Model-providers layer

- `src/model-providers/openai.ts`, `src/model-providers/omlx.ts` — only needed for codex/local; remove along with their registry entries in `src/model-providers/index.ts` *(unless `local` MLX support is kept for educational use, which is a separate decision)*

---

## CLASSROOM-ONLY (preserve through catch-up — do NOT touch)

These have no upstream counterpart and define classroom's identity. Carry them through any catch-up unchanged.

### Whole subsystems

- `src/channels/playground/` (entire tree — every tab, every API handler, every public asset)
- `src/agent-builder/` (entire tree)
- All `src/class-*.ts`, `src/classroom-*.ts`
- All `src/gws-*.ts`, `src/student-*.ts`
- `src/db/classroom-roster.ts` + tests
- `src/credential-proxy.ts` (entire file — upstream has none)
- `src/container-env-registry.ts`, `src/class-container-env.ts`
- All knowledge/ subsystem (src/knowledge/, src/library/)
- `src/channels/playground` integration with delivery's `trace` kind handling

### Modules and patterns to preserve

- `classroom-provider-resolver.ts` — per-student credential resolution hook *(the codex branch becomes deletable; the GWS branch stays)*
- `src/host-sweep.ts:137` — `backupCentralDb()` call (upstream removed this; classroom keeps it)
- `src/index.ts` — `onHostReady` / `getHostReadyCallbacks` registry (used by playground HTTP server auto-start)
- `src/delivery.ts` — `ChannelDeliveryMeta` interface, `meta?` parameter on `deliver`, token/latency extraction, `trace` kind handling
- `src/container-runner.ts:520-579` — credential proxy env block (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, auth detection, OPENAI_API_KEY, OMLX_API_KEY, X_NANOCLAW_AGENT_GROUP, collectContainerEnv loop)
- `src/container-runner.ts:buildMounts:358-370` — `/opt/homebrew/var/www/sites` web hosting mount block
- `src/group-init.ts:99-108` — `seedInitialLibraryEntry` call (playground-only feature)

### Schema additions

- `src/db/migrations/014-agent-model.ts` (adds `agent_groups.model`)
- `src/db/migrations/015-agent-group-metadata.ts`
- `src/db/migrations/016-classroom-roster.ts`
- All `src/db/migrations/module-class-*.ts` (4 files: login, token, pin, pair tables)
- `agent_groups.metadata` column (classroom-only — stores per-group student email, Drive folder ID etc.)

### Provider-abstraction extensions classroom is *ahead* on

- `src/container-runner.ts:resolveProviderName` — classroom's 3-arg version with `agentGroup.agent_provider` middle tier supports DB-level per-group overrides (fix for "Claude models shown for Codex group" bug). **Classroom is ahead — do not regress to upstream's 2-arg version.**
- `src/container-runner.ts:syncSkillSymlinks` — classroom's 3-arg version adds custom-skill per-agent override + stale symlink cleanup. **Classroom is ahead — do not regress.**

---

## MISSING MIGRATIONS (only in upstream)

| Migration | What it does | Decision |
|---|---|---|
| `014-container-configs` | Creates `container_configs` table | **SKIP** (decision above) |
| `015-cli-scope` | Adds `cli_scope` column to `container_configs` | **SKIP** (depends on 014) |
| Idempotent `ALTER TABLE messages_in ADD COLUMN on_wake` | Adds `on_wake` for first-poll-only delivery | **BRING FORWARD** (paired with onWake message support) |

---

## NEEDS DECISION — Open questions

### Architectural

1. **`ProviderEvent` schema:** keep classroom's rich event vocabulary (with `tool_use`, `tool_result`, `model_call`, `compacted`, and metadata on `result`) and have pi emit it, OR adopt upstream's slim schema and lose the playground trace panel features. *Recommend: keep classroom's, have pi emit. Classroom's playground depends on it.*

2. **`container_configs` DB migration:** skip (recommended) or adopt? Adopting is a 1-2 week extra lift. Skipping means a few BRING FORWARD items (self-mod respawn details) can't be cleanly lifted.

3. **Migration version collision:** classroom 014 = `agent-model`, upstream 014 = `container-configs`. If we skip 014/015 upstream, no collision. If we adopt, rename and re-sequence.

### Auth / provider plumbing

4. **`src/providers/auth-registry.ts` and `src/channels/playground/api/provider-auth.ts` fate:** if pi adopts per-student OAuth (like Claude Pro / ChatGPT subscriptions), the registry pattern stays and gets a pi-spec. If pi uses pool credentials only (instructor-provided key), most of this layer becomes deletable. *Need: decision on pi auth model for classroom.*

5. **`classroom-provider-resolver.ts` codex branch:** straightforward delete with pi-only. Keep the GWS branch.

6. **`local` provider (MLX) status:** the diff treats `local` as in scope for deletion if pi replaces it. If `local` is kept for educational use (running mlx-omni-server locally), several BECOMES DELETABLE items don't apply. *Need: decision on `local`.*

### Image handling

7. **`imagePaths` removal:** upstream deleted `imagePaths` from `QueryInput` entirely. Classroom still wires it through. If pi handles images via content blocks rather than `imagePaths`, the wiring becomes dead code. *Need: confirm pi image intake before deleting.*

8. **`provider-switch.ts` and `model-switch.ts` simplification:** post-pi-only, these can be drastically simplified or replaced by `ncl groups config update --provider pi --model <x>`. If the container_configs DB migration is skipped, the `*-switch.ts` files stay but get simpler.

---

## Recommended sequencing

### Phase A — Independent prep work (can start anytime, ~3-5 days)

1. **Bring forward security fixes** (`handleSenderApprovalResponse` colon safety, `hasAdminPrivilege` check in `handleChannelApprovalResponse`). These are bug fixes regardless of pi work.
2. **Bring forward `install-slug.ts`** — single new file, no dependencies.
3. **Bring forward `transport-errors.ts`** + test — single new file.
4. **Bring forward `claude.rotate.test.ts` + `maybeRotateContinuation`** on the interface — these will live briefly (claude.ts gets deleted later) but the interface stays for pi's eventual implementation.
5. **Backport CLI regression tests** (`groups.test.ts`, `destinations.test.ts`, `dispatch.test.ts`).
6. **Fix `class-student-provision.ts` codex hardcode + `resolveEffectiveModel`** — these are bugs today (independent of pi).

### Phase B — Provider abstraction prep (~3-5 days)

7. **Add `effort` field** to `ProviderOptions` in classroom's types.ts.
8. **Add `onWake` field** to `messages_in` + `writeSessionMessage` + migration.
9. **Bring forward `container-restart.ts`** (depends on onWake).
10. **Add `killContainer(onExit)` callback** + the SQLite corruption streak-exit logic in poll-loop.

### Phase C — Pi port (~1 week, after Phase B)

11. **Lift pi files from personal to classroom**: `container/agent-runner/src/providers/pi.ts`, `pi-auth.ts`, `pi-mcp-bridge.ts`, `pi-model.ts`, `pi-tools/web-search.ts`, plus `src/providers/pi.ts`.
12. **Adapt pi.ts to classroom's `ProviderEvent` schema** — emit `tool_use`, `tool_result`, `model_call`, `compacted` events; add `tokens`, `latencyMs`, `provider`, `model` to `result`.
13. **Adapt pi-auth.ts for credential-proxy** — drop OneCLI Bearer convention; use `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` env vars the proxy injects. The `PLACEHOLDER_ENV_BY_PROVIDER` table may shrink dramatically (only providers the proxy supports).
14. **Adapt pi-tools/web-search.ts for credential-proxy** — drop OneCLI HTTPS_PROXY assumption; add explicit Authorization header from env.
15. **Wire pi into the registry** (`container/agent-runner/src/providers/index.ts`, `src/providers/index.ts`).

### Phase D — Delete claude/codex (~3-4 days)

16. **Delete codex files** — `container/agent-runner/src/providers/codex*.ts`, `src/providers/codex*.ts`, `src/class-codex-auth.ts`, `src/codex-auth-switch.ts`, `src/host-codex-api-key.ts`, `src/admin-handlers/codex-auth.ts`, `src/model-catalog-refresh.ts`.
17. **Delete claude files** — `container/agent-runner/src/providers/claude*.ts`, `src/providers/claude-spec.ts`. *(keep `maybeRotateContinuation` interface for pi.)*
18. **Update playground UI hardcodes** — collapse to pi-only entries in `home.js`, `models.js`, `direct-chat.ts`, `provider-auth.ts`.
19. **Update `class-student-provision.ts`** to provision pi agents by default.
20. **Update `model-switch.ts`** / `provider-switch.ts` to pi-only (or replace with `ncl groups config update`).
21. **Delete or simplify `auth-registry.ts`** (depends on pi auth decision).

### Phase E — Polish (~2-3 days)

22. **Add `container/CLAUDE.providers/pi.md`** fragment (adapted from personal's pi.md).
23. **Update `model-catalog.ts`** to include pi entries; remove codex entries.
24. **Update tests** — replace all "expects 'claude' or 'codex'" assertions with pi.
25. **Run a full session smoke test** — Telegram message → pi turn → response back.

**Total: 2.5-3 weeks** (calendar, full focus).

---

## Cross-references

- [`pi-personal-audit-2026-05-25.md`](pi-personal-audit-2026-05-25.md) — the existing pi code audit. The HIGH-priority pi bugs (sessionsRoot hardcode, modelProvider undefined throw, HTTP MCP bridge silently dead, error double-emit) should be fixed in personal BEFORE Phase C lifts pi.ts to classroom — otherwise classroom inherits them.
- [`classroom-pre-pi-audit-2026-05-25.md`](classroom-pre-pi-audit-2026-05-25.md) — earlier audit of classroom state. Findings still valid; this catch-up doc supersedes the "port plan" framing.
- [`pi-sub-agents.md`](pi-sub-agents.md), [`pi-migration-gotchas.md`](pi-migration-gotchas.md), [`classroom-cost-guardrails.md`](classroom-cost-guardrails.md) — all dependent on this catch-up landing first.
