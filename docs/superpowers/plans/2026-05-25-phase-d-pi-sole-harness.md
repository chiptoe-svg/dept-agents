# Phase D — Pi as sole agent harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) for tracking.

**Goal:** Make pi the only agent harness in classroom by deleting `claude.ts` (Claude Agent SDK) and `codex.ts` (Codex CLI) — both host-side provider container configs AND the in-container provider implementations. Plus the supporting wiring: model_provider DB column, playground dropdown rework, dead-code cleanup in chat.js.

**Why:** Three landed concurrently in Phase C make this safe to do now:
1. Pi → anthropic OAuth (with all four landmines fixed: sk-ant-oat- prefix, beta header, Claude Code preamble, model.baseUrl override)
2. Pi → openai-codex via ChatGPT OAuth (works for routing; usage tokens are zero — upstream pi-ai gap, see `reference-pi-ai-codex-usage-gap`)
3. The provider-drift bug (agent_groups.agent_provider vs container_configs.provider) was identified and the migration script `scripts/migrate-to-pi.ts` aligns all three sources

**Architecture after Phase D:** `container_configs.provider` is always `pi`. `container_configs.model_provider` (new column) selects the upstream API (anthropic / openai / openai-codex / local / deepseek / groq / …). `container_configs.model` is the specific model id. Pi-ai routes accordingly. No more claude.ts or codex.ts on either host or container side.

**Prerequisites met as of 2026-05-25:**
- Tag `phase-c-verified-2026-05-25` includes all the OAuth fixes
- 10 test student agents deleted (only instructor, TA, students 1-3, bench, Pi Test remain)
- All remaining agents migrated to provider=pi via `scripts/migrate-to-pi.ts`
- `NANOCLAW_PI_MODEL_PROVIDER` env var fallback in pi.ts works
- Trace renderer polished for pi-native events (collapse, AGENT CALL header, error surfacing, internal-event filter)

**Out of scope:**
- Per-student pi auth configuration (separate plan, post-Phase-D)
- Migrating Claude SDK continuation tokens to pi JSONL (drop on first message; classroom has no real users yet)
- Fixing pi-ai's openai-codex usage gap (upstream PR, not classroom)

---

## File structure

**Files deleted:**
```
src/providers/claude.ts                                  # host container config
src/providers/codex.ts                                   # host container config (also drops the per-student resolver registry — replace with a pi-equivalent if/when per-student pi auth ships)
src/providers/claude-spec.ts                             # OAuth endpoints registration for claude
src/providers/codex-spec.ts                              # OAuth endpoints registration for codex
container/agent-runner/src/providers/claude.ts           # in-container Claude SDK adapter
container/agent-runner/src/providers/codex.ts            # in-container Codex CLI adapter
container/agent-runner/src/providers/claude.test.ts
container/agent-runner/src/providers/codex.test.ts
src/class-codex-auth.ts                                  # per-student codex auth resolver (replace with pi-auth chain if/when per-student pi lands)
src/class-codex-auth.test.ts
```

**Files modified:**
```
src/db/migrations/021-container-configs-model-provider.ts  # NEW: add model_provider column
src/db/container-configs.ts                                # extend ContainerConfigRow + JSON_COLUMNS as needed (model_provider is a scalar TEXT)
src/types.ts                                               # ContainerConfigRow.model_provider
src/container-config.ts                                    # configFromDb passes model_provider through
src/providers/index.ts                                     # drop claude+codex imports
container/agent-runner/src/providers/index.ts              # drop claude+codex+mock imports if mock is unused
container/agent-runner/src/providers/factory.ts            # default provider lookup falls to pi
src/cli/resources/groups.ts                                # add --model-provider flag to config-update verb
src/channels/playground/api/models.ts                     # active-model API returns + accepts model_provider
src/channels/playground/public/tabs/chat.js                # provider dropdown becomes model-provider dropdown; drop unreachable model_call/tool_use/tool_result render paths once verified no other code emits them
src/channels/playground/public/tabs/persona.ts (if exists) # ditto
src/index.ts                                               # if anything imports claude-spec/codex-spec directly, remove
container/agent-runner/src/index.ts                        # default provider 'claude' fallback at top of loadConfig → drop, fail explicit instead
```

**Files preserved (used by pi):**
```
container/agent-runner/src/providers/pi*.ts
container/agent-runner/src/providers/types.ts
container/agent-runner/src/providers/provider-registry.ts
container/agent-runner/src/providers/mock.ts            # keep for tests
src/providers/pi.ts
src/providers/provider-container-registry.ts            # pi uses this registry
src/credential-proxy.ts                                 # all OAuth+x-api-key substitution still applies for pi
```

---

## Conventions

- **Working branch:** `catchup/phase-d-2026-05-25` off `phase-c-verified-2026-05-25` (or wherever the catch-up branch is at when starting)
- **Commit per task** with `d-N:` prefix
- **After every task:** `pnpm run build` + `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit` + `pnpm test` + `cd container/agent-runner && bun test src/`
- **Run pnpm run build yourself** — vitest tolerates TS errors tsc rejects
- **Use codegraph for structural queries** before grep (see `feedback-use-codegraph-for-structural-queries`)
- **Live verification** between major tasks: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4` + send a message via playground

---

## Task d-1: Branch + DB migration for model_provider column

- [ ] **Step 1: Branch off the latest catch-up state**
  ```
  cd /Users/admin/projects/nanoclaw
  git checkout phase-c-verified-2026-05-25  # or HEAD of catchup/phase-c-2026-05-25 if more commits landed
  git checkout -b catchup/phase-d-2026-05-25
  ```

- [ ] **Step 2: Backup the live DB**
  ```
  TS=$(date +%Y%m%d-%H%M%S)
  pnpm exec tsx scripts/backup-db.ts "data/v2.db.backup-pre-phase-d-${TS}"
  ```

- [ ] **Step 3: Create migration 021-container-configs-model-provider.ts**
  Schema: `ALTER TABLE container_configs ADD COLUMN model_provider TEXT`.
  Backfill from existing `env.NANOCLAW_PI_MODEL_PROVIDER` when present.

- [ ] **Step 4: Register the migration in src/db/migrations/index.ts**

- [ ] **Step 5: Extend ContainerConfigRow type + getContainerConfig/createContainerConfig**
  Add `model_provider: string | null` to the row shape and the INSERT column list. model_provider is a scalar (not JSON), so no entry in JSON_COLUMNS.

- [ ] **Step 6: Make configFromDb pass model_provider into ContainerConfig**
  Also update materializeContainerJson so container.json includes `modelProvider` from the new column.

- [ ] **Step 7: Container loadConfig already reads raw.modelProvider** (done in Phase C)

- [ ] **Step 8: pi.ts precedence — options.modelProvider (now populated by host) > env var > default**
  Already in pi.ts as of phase-c-verified-2026-05-25. Verify the chain still works.

- [ ] **Step 9: Add --model-provider flag to `ncl groups config-update`** in src/cli/resources/groups.ts

- [ ] **Step 10: typecheck + tests + commit**
  Subject: `feat(db): container_configs.model_provider column (d-1)`

---

## Task d-2: Playground UI — replace provider dropdown with model-provider

- [ ] **Step 1: Inventory the dropdown's wiring** — `chat.js` provider-sel, `models.ts` API handler, `model-catalog.ts`, the active-model PUT endpoint
- [ ] **Step 2: Rework the API** — `/api/drafts/<folder>/models` returns the catalog grouped by model-provider; the active-model PUT accepts {modelProvider, model} and writes to container_configs.model_provider + container_configs.model
- [ ] **Step 3: Rework chat.js** — provider dropdown shows pi-routable providers (anthropic, openai-codex, openai, local, deepseek, groq, …) rather than agent harness names
- [ ] **Step 4: Live test** — flip a real agent's model-provider via UI, confirm the container respawns with the right model
- [ ] **Step 5: Commit** with subject `feat(playground): model-provider dropdown replaces provider selector (d-2)`

---

## Task d-3 (parallel-safe): Delete host-side claude.ts + codex.ts + auth-registry plumbing they're sole owners of

- [ ] **Step 1: Search for any remaining importers of src/providers/claude.ts or src/providers/codex.ts**
  Use `codegraph_callers` for the exports. The exports we know about: `registerCodexAuthResolver`, `instructorHostResolver`, etc.

- [ ] **Step 2: Decide on the per-student auth resolver chain**
  codex.ts's resolver chain pattern needs to either disappear or be ported to pi-auth. For Phase D, the simplest path is to delete it; per-student pi auth is a separate post-Phase-D plan.

- [ ] **Step 3: Drop class-codex-auth.ts** (and its test) since it registers against codex.ts's chain

- [ ] **Step 4: Drop src/providers/claude.ts and src/providers/codex.ts** + their spec files (claude-spec.ts, codex-spec.ts) IF they aren't needed for the auth-store (provider id → OAuth endpoints used by the playground's connect flow). Verify with codegraph_callers first.

- [ ] **Step 5: Trim src/providers/index.ts to only import pi**

- [ ] **Step 6: typecheck + tests + commit**
  Subject: `refactor(provider): delete host-side claude.ts + codex.ts (d-3)`

---

## Task d-4 (parallel-safe): Delete container-side claude.ts + codex.ts adapters

- [ ] **Step 1: codegraph_callers for createProvider('claude') / createProvider('codex')** to find any test fixtures or call sites pinning to those names

- [ ] **Step 2: Delete container/agent-runner/src/providers/claude.ts + codex.ts + their tests**

- [ ] **Step 3: Trim container/agent-runner/src/providers/index.ts to import only pi (+ mock for tests)**

- [ ] **Step 4: Update factory.ts** — default to pi when an unknown provider name is requested (or hard-error; pick the strict path so misconfigs surface fast)

- [ ] **Step 5: Container typecheck + bun test + commit**
  Subject: `refactor(container): delete claude.ts + codex.ts adapters (d-4)`

---

## Task d-5: Strip now-dead trace render paths in chat.js

- [ ] **Step 1: Confirm no live code emits `model_call`, `tool_use`, `tool_result` ProviderEvents anymore**
  Grep container/agent-runner/src/ for emitTraceToPlayground; only pi_event should be left. Same for the agent_call SSE path.

- [ ] **Step 2: Delete the model_call/tool_use/tool_result render paths in chat.js**
  Keep them only if you want roll-back compatibility — but with the tag retained you can roll back the whole branch, so safer to delete and reduce surface.

- [ ] **Step 3: Visually verify trace is unchanged for live pi turns**

- [ ] **Step 4: Commit**
  Subject: `refactor(playground): remove dead trace paths (d-5)`

---

## Task d-6: Rebuild container + restart + live validation

- [ ] **Step 1: `./container/build.sh`**
- [ ] **Step 2: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`** + tail logs
- [ ] **Step 3: Send messages to each kept agent group via playground or telegram** — instructor, TA, student_01-03, bench, Pi Test
  - All should reply via pi → anthropic
  - Trace shows AGENT CALL anthropic/claude-sonnet-4-5 + collapsed assistant + accurate turn-usage sum
- [ ] **Step 4: Try switching one agent's model-provider via the new dropdown** — set it to openai-codex with model gpt-5.4-mini, send a message, confirm the container respawns and pi routes to ChatGPT OAuth
- [ ] **Step 5: Tag** `phase-d-complete-2026-05-25` (or whatever date)

---

## Self-review checklist

- [ ] No `import` of claude.ts or codex.ts anywhere in src/ or container/agent-runner/src/
- [ ] No `provider=claude` or `provider=codex` strings appear in chat.js, models.ts, model-catalog.ts, or the seats config (they may have been there as defaults/labels)
- [ ] All agent groups in the live DB are on `provider=pi` (run `./bin/ncl groups list`)
- [ ] `container_configs.model_provider` is populated for every group (no NULLs that would re-trigger the env-fallback path)
- [ ] Migration 021 is idempotent — second run is a no-op
- [ ] Host typecheck + container typecheck clean
- [ ] Host + container test suites pass
- [ ] Live test of all kept agents passes
- [ ] The Phase C tag `phase-c-verified-2026-05-25` still works as a rollback target — verify by checking it out in a worktree, building, and restarting against a copy of the backup DB

---

## Cross-references

- Phase C parent: `docs/superpowers/plans/2026-05-25-phase-c-pi-port.md`
- Phase B½ (DB infra): `docs/superpowers/plans/2026-05-25-phase-bhalf-container-configs-db.md`
- Audit findings driving this consolidation: `plans/classroom-upstream-catchup-2026-05-25.md`
- Known pi-ai upstream gap: memory `reference-pi-ai-codex-usage-gap`
