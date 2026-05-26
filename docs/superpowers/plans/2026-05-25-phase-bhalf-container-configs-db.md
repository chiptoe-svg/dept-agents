# Phase B½ — Container Configs DB Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the parallel-dispatch sections (marked "Subagent dispatch point") or superpowers:executing-plans for sequential execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move container config from filesystem `groups/<folder>/container.json` files to a SQLite `container_configs` table. Add `ncl groups config *` verbs for in-band config editing. Drop the classroom-only `agent_groups.model` column in favor of `container_configs.model`. The container side and credential-proxy contract are unchanged — `materializeContainerJson()` writes the on-disk file from the DB on every spawn.

**Architecture:** New migration creates the `container_configs` table; new module provides scalar/JSON update API; existing on-disk read/write callers are swapped to DB-backed equivalents in parallel; new CLI verbs land for operator-facing config management. Backfill at startup seeds rows from existing container.json files (idempotent).

**Tech Stack:** TypeScript on Node 22, better-sqlite3, pnpm + vitest. No container-side changes; no credential-proxy changes.

**Prerequisites:**
- Branch `catchup/phase-a-2026-05-25` HEAD at commit `95f575c` (Phase A + B complete)
- Tag `pre-pi-catchup-2026-05-25` as rollback point
- DB backup at `data/v2.db.backup-pre-pi-20260525`
- Upstream nanoclaw cloned at `/tmp/nanoclaw-upstream` on `main`

**Out of scope (deferred to follow-up plans):**
- Pi port (separate plan: `2026-05-25-phase-c-pi-port.md`)
- Container-side changes (none needed)
- Claude/Codex deletion (Phase D, future plan)

---

## File structure

**Files created (by copying or adapting upstream):**

```
src/db/migrations/016-container-configs.ts           # Schema (renamed from upstream 014)
src/db/migrations/017-cli-scope.ts                   # cli_scope column (renamed from upstream 015)
src/db/migrations/018-drop-agent-groups-model.ts     # New: migrate model into container_configs, drop column
src/db/container-configs.ts                          # Lifted from upstream
src/db/container-configs.test.ts                     # Unit tests
src/backfill-container-configs.ts                    # Lifted from upstream
src/backfill-container-configs.test.ts               # Unit test
```

**Files modified:**

```
src/types.ts                                          # Add ContainerConfigRow type
src/container-config.ts                               # Replace body — DB-backed
src/container-runner.ts                               # readContainerConfig → materializeContainerJson
src/group-init.ts                                     # Add ensureContainerConfig call
src/modules/self-mod/apply.ts                         # Use updateContainerConfigScalars/Json
src/cli/resources/groups.ts                           # +6 config verbs
src/index.ts                                          # Call backfillContainerConfigs() on startup
src/db/migrations/index.ts                            # Register 016, 017, 018
src/model-switch.ts                                   # Read model from container_configs (was agent_groups)
src/channels/playground/api/models.ts                 # 3 handlers swap to new API (codegraph-surfaced)
src/channels/playground/api-routes.ts                 # route function (codegraph-surfaced)
src/claude-md-compose.ts                              # composeGroupClaudeMd (codegraph-surfaced)
scripts/class-skeleton.ts                             # provisionGroup (codegraph-surfaced)
setup/migrate/seed-v2.ts                              # seed function (codegraph-surfaced)
```

**Files verified-no-change:**

```
src/skeleton-mount-registry.ts                        # Uses ContainerConfig type; re-export stays
```

---

## Conventions

- **Working branch:** `catchup/phase-bhalf-2026-05-25` off `catchup/phase-a-2026-05-25` HEAD
- **Commit per task:** each task gets its own commit with `bhalf-N:` prefix
- **After every task:** run `pnpm run build` + relevant tests; verify green before moving on
- **Subagent dispatch:** use `superpowers:dispatching-parallel-agents`. Agent prompts are full briefs — paste into the Agent tool's `prompt`, use sonnet
- **Use codegraph for structural lookups** before grep where possible
- **Always run `pnpm run build` yourself** — vitest tolerates type errors tsc rejects
- **Never run `git add -A` or `git add .`** — stage explicit paths only
- All paths absolute or relative to `/Users/admin/projects/nanoclaw`

---

## Task bhalf-1: Branch + DB migrations + container-configs module

**Files:**
- Create: `src/db/migrations/016-container-configs.ts`
- Create: `src/db/migrations/017-cli-scope.ts`
- Create: `src/db/container-configs.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Create the working branch**

Run: `cd /Users/admin/projects/nanoclaw && git checkout catchup/phase-a-2026-05-25 && git checkout -b catchup/phase-bhalf-2026-05-25 && git log -1 --format='%h %s'`

Expected: `95f575c feat(poll-loop): SQLite corruption streak-exit guard`

- [ ] **Step 2: Add ContainerConfigRow type to src/types.ts**

Append to `src/types.ts` a new interface `ContainerConfigRow` with fields: `agent_group_id` (string), `provider/model/effort/image_tag/assistant_name` (string|null), `max_messages_per_prompt` (number|null), `skills/mcp_servers/packages_apt/packages_npm/additional_mounts` (string — JSON-encoded), `cli_scope` (string, defaults 'group'), `updated_at` (string). Match upstream's shape in `/tmp/nanoclaw-upstream/src/types.ts` if present; otherwise mirror the column list in upstream's migration 014.

- [ ] **Step 3: Create migration 016-container-configs.ts**

Copy `/tmp/nanoclaw-upstream/src/db/migrations/014-container-configs.ts` verbatim to `src/db/migrations/016-container-configs.ts`. Then change `version: 14` to `version: 16` and the exported name `migration014` to `migration016`. Do not modify the table-creation SQL.

- [ ] **Step 4: Create migration 017-cli-scope.ts**

Copy `/tmp/nanoclaw-upstream/src/db/migrations/015-cli-scope.ts` verbatim to `src/db/migrations/017-cli-scope.ts`. Change version 15→17 and `migration015`→`migration017`.

- [ ] **Step 5: Register migrations in src/db/migrations/index.ts**

Open the file. Find the existing migration array. Add imports for `migration016` and `migration017` and append both to the array. Match the existing import + array-push pattern exactly.

- [ ] **Step 6: Create src/db/container-configs.ts**

Copy `/tmp/nanoclaw-upstream/src/db/container-configs.ts` verbatim to the same path in classroom. No adaptation needed — uses `getDb()` from `./connection.js` which classroom has.

- [ ] **Step 7: Typecheck**

Run: `pnpm run build`

Expected: clean exit, no errors.

- [ ] **Step 8: Run migrations against a throwaway DB**

Create `scripts/verify-bhalf-1.ts` with: imports `initDb` from `../src/db/connection.js` and `runMigrations` from `../src/db/migrations/index.js`. Initializes a DB at `/tmp/migration-test-<timestamp>.db`, runs migrations, queries `PRAGMA table_info('container_configs')`, prints column names, unlinks the file.

Run: `pnpm tsx scripts/verify-bhalf-1.ts`

Expected output line: `container_configs columns: agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, updated_at, cli_scope`

Then delete the script: `rm scripts/verify-bhalf-1.ts`

- [ ] **Step 9: Commit**

Stage these paths explicitly: `src/db/migrations/016-container-configs.ts`, `src/db/migrations/017-cli-scope.ts`, `src/db/migrations/index.ts`, `src/db/container-configs.ts`, `src/types.ts`. Commit with subject `feat(db): container_configs table + CRUD module (bhalf-1)` and body summarizing what landed. End with the Claude Opus 4.7 co-author line.

---

## Task bhalf-2: Rewrite container-config.ts to be DB-backed

Sequential — many downstream tasks depend on the new API shape.

**Files:**
- Modify: `src/container-config.ts`

- [ ] **Step 1: Read classroom's existing container-config.ts in full**

Open `src/container-config.ts` (152 lines). Note what's exported: `ContainerConfig`, `McpServerConfig`, `AdditionalMountConfig` interfaces; `containerConfigPath`, `emptyConfig`, `readContainerConfig`, `writeContainerConfig`, `updateContainerConfig`, `initContainerConfig` functions.

- [ ] **Step 2: Read upstream's replacement in full**

Open `/tmp/nanoclaw-upstream/src/container-config.ts` (89 lines). Note: same three interfaces + `configFromDb(row, group)` + `materializeContainerJson(agentGroupId)`.

- [ ] **Step 3: Replace src/container-config.ts with the upstream version**

Copy upstream's file body verbatim. Verify imports resolve (`GROUPS_DIR` from `./config.js`, `getContainerConfig` from `./db/container-configs.js`, `getAgentGroup` from `./db/agent-groups.js`, types from `./types.js` — all present in classroom).

- [ ] **Step 4: Add a back-compat `containerConfigPath()` helper**

At the bottom of the new file, add a small helper that takes a folder name and returns `path.join(GROUPS_DIR, folder, 'container.json')`. Imports `path` and `GROUPS_DIR`. Some classroom callers may rely on this for inspection or backup.

- [ ] **Step 5: Typecheck (errors expected in callers)**

Run: `pnpm run build`

Expected: type errors in container-runner.ts, group-init.ts, self-mod/apply.ts, playground API handlers, claude-md-compose.ts, and the two scripts. These resolve in parallel tasks bhalf-3 through bhalf-8.

- [ ] **Step 6: Commit (intentional WIP state)**

Stage `src/container-config.ts`. Commit with subject `refactor(container-config): replace file-based API with DB-backed (bhalf-2)` and a body explaining the WIP state.

---

## Subagent dispatch point: bhalf-3 through bhalf-8 in parallel

Capture the current branch HEAD before dispatching. After all 6 return, run typecheck once.

**Dispatch one sonnet agent per task below.** Each agent's brief is self-contained — paste the brief into the Agent tool's `prompt`. After collection, run `pnpm run build && pnpm test` from `/Users/admin/projects/nanoclaw`. If clean, commit each agent's changes as its own commit. If type errors remain, fix specific spots and re-run.

---

## Task bhalf-3 (parallel): Adapt container-runner.ts spawn path

**Agent brief:**

> Adapt `src/container-runner.ts` in `/Users/admin/projects/nanoclaw` to use the DB-backed container-config API.
>
> Phase bhalf-2 just landed: `src/container-config.ts` now exports `materializeContainerJson(agentGroupId)` and `configFromDb(row, group)` instead of `readContainerConfig(folder)` / `writeContainerConfig(folder, config)`. The file still ends up on disk at `groups/<folder>/container.json` — only the read/write source changes.
>
> Reference: `/tmp/nanoclaw-upstream/src/container-runner.ts` around lines 120-135 for the spawn-path adaptation. Classroom's version is structurally similar but has extra credential-proxy env injection (around lines 520-579) that must be preserved unchanged.
>
> Specific changes:
> 1. Replace `import { readContainerConfig, writeContainerConfig } from './container-config.js';` with `import { materializeContainerJson } from './container-config.js';`.
> 2. In `spawnContainer()`, swap `const containerConfig = readContainerConfig(agentGroup.folder);` for `const containerConfig = materializeContainerJson(agentGroup.id);`.
> 3. If `writeContainerConfig` is called elsewhere to update the file: replace with `updateContainerConfigScalars(agentGroupId, {...})` or `updateContainerConfigJson(agentGroupId, column, value)` from `src/db/container-configs.ts`. Then call `materializeContainerJson()` after if downstream reads the file.
> 4. Preserve every line of credential-proxy env injection (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, the placeholder env vars, OMLX_API_KEY, X_NANOCLAW_AGENT_GROUP, GWS_MCP_RELAY_URL, collectContainerEnv loop).
> 5. Preserve classroom's 3-arg `resolveProviderName(session, agentGroup, containerConfig)` — do NOT regress to upstream's 2-arg form.
> 6. Preserve classroom's `syncSkillSymlinks` 3-arg form with custom-skills handling.
>
> Verification: `pnpm run build` — container-runner.ts type-clean. Other files may still error (parallel agents are fixing them).
>
> Return: every line changed with file:line refs. List preserved sections to prove no regression.

After return, stage `src/container-runner.ts` and commit with subject `refactor(container-runner): use materializeContainerJson at spawn (bhalf-3)`.

---

## Task bhalf-4 (parallel): Adapt group-init.ts

**Agent brief:**

> Adapt `src/group-init.ts` in `/Users/admin/projects/nanoclaw` to call `ensureContainerConfig` instead of `initContainerConfig`.
>
> The old `initContainerConfig(folder)` wrote an empty container.json file. The new pattern is `ensureContainerConfig(agentGroupId)` from `src/db/container-configs.ts` which inserts an empty DB row if absent.
>
> Reference: `/tmp/nanoclaw-upstream/src/group-init.ts` shows the upstream pattern.
>
> Specific changes:
> 1. Find the call site for `initContainerConfig(group.folder)`. Replace with `ensureContainerConfig(group.id)`. Add the import.
> 2. Preserve `seedInitialLibraryEntry` (classroom-only playground feature) and any other classroom-specific calls.
> 3. Don't refactor unrelated code.
>
> Verification: `pnpm run build` — group-init.ts type-clean.
>
> Return: file:line of each change.

After return, stage `src/group-init.ts` and commit with subject `refactor(group-init): use ensureContainerConfig for DB-backed init (bhalf-4)`.

---

## Task bhalf-5 (parallel): Rewrite self-mod/apply.ts for new API

**Agent brief:**

> Rewrite `src/modules/self-mod/apply.ts` in `/Users/admin/projects/nanoclaw` to use the DB-backed container-config API.
>
> The handlers `applyInstallPackages` and `applyAddMcpServer` currently call `updateContainerConfig(folder, updates)`. The new API is `updateContainerConfigScalars(agentGroupId, {...})` and `updateContainerConfigJson(agentGroupId, column, value)` from `src/db/container-configs.ts`.
>
> Reference: `/tmp/nanoclaw-upstream/src/modules/self-mod/apply.ts` (126 lines). Classroom's current version is 85 lines.
>
> Specific changes:
> 1. Swap imports.
> 2. For `applyInstallPackages`: read current packages via `getContainerConfig(agentGroupId)`, parse the JSON arrays, deduplicate merged list, call `updateContainerConfigJson(agentGroupId, 'packages_apt' | 'packages_npm', mergedArray)`. After update, `materializeContainerJson(agentGroupId)` so downstream file reads see the change.
> 3. For `applyAddMcpServer`: similarly read existing `mcp_servers`, add the new entry by key, call `updateContainerConfigJson(agentGroupId, 'mcp_servers', updatedMap)`, then materialize.
> 4. After applying, kill running containers for the group via `restartAgentGroupContainers(id, 'self-mod applied', message?)` from `src/container-restart.ts` (landed in Phase B). Use a wakeMessage matching upstream's text if upstream has one.
> 5. Preserve `registerApprovalHandler('install_packages', ...)` and `'add_mcp_server'` registration keys.
>
> Verification: `pnpm run build` — apply.ts type-clean.
>
> Return: summary of every API call swap, with file:line refs.

After return, stage `src/modules/self-mod/apply.ts` and commit with subject `refactor(self-mod): use container_configs DB API + onWake respawn (bhalf-5)`.

---

## Task bhalf-6 (parallel): Add 6 ncl groups config verbs

**Agent brief:**

> Add 6 custom verbs to `src/cli/resources/groups.ts` in `/Users/admin/projects/nanoclaw`: `config get`, `config update`, `config add-mcp-server`, `config remove-mcp-server`, `config add-package`, `config remove-package`.
>
> Reference: `/tmp/nanoclaw-upstream/src/cli/resources/groups.ts:201-354` has the upstream implementations.
>
> Constraints:
> 1. Preserve classroom's existing `customOperations.delete` (Phase A) and `customOperations.restart` (Phase B).
> 2. Imports come from `src/db/container-configs.ts` (`getContainerConfig`, `updateContainerConfigScalars`, `updateContainerConfigJson`) and `src/types.ts` (`ContainerConfigRow`).
> 3. After every config-mutating verb, call `materializeContainerJson(agentGroupId)` to refresh the on-disk file.
> 4. After config changes that affect the running container (model/provider/effort/mcp/packages), call `restartAgentGroupContainers(id, 'config updated', message?)` from `src/container-restart.ts`.
>
> Structure: Each verb is a key under `customOperations:` with `{ access: 'approval', description: '...', handler: async (args, ctx) => {...} }`. The dispatcher constructs `groups-config-get` etc. from the resource+verb pair.
>
> Verification: `pnpm run build` — groups.ts type-clean.
>
> Return: summary of verbs added with their accept/effect semantics.

After return, stage `src/cli/resources/groups.ts` and commit with subject `feat(cli): add ncl groups config CRUD verbs (bhalf-6)`.

---

## Task bhalf-7 (parallel): Drop agent_groups.model overlap

**Agent brief:**

> Drop classroom-only `agent_groups.model` column (from migration 014-agent-model). Migrate values to `container_configs.model`.
>
> Files:
> - Create: `src/db/migrations/018-drop-agent-groups-model.ts`
> - Modify: `src/db/migrations/index.ts`
> - Modify: `src/model-switch.ts`
> - Modify: `src/types.ts` (remove `model` field from `AgentGroup`)
> - Modify: any other reader (use codegraph to find them)
>
> Migration 018 logic:
> - Version 18, name 'drop-agent-groups-model'.
> - For each row in `agent_groups` with non-null `model`, ensure a `container_configs` row exists (INSERT OR IGNORE with defaults from migration 016), then update `container_configs.model` (don't overwrite if container_configs already has a model — use COALESCE or a guarded UPDATE).
> - Then ALTER TABLE agent_groups DROP COLUMN model.
> - Wrap in `db.transaction()`.
> - Reference the structure of existing migrations under `src/db/migrations/` for the format.
>
> Code adaptations:
> 1. Register migration 018 in `src/db/migrations/index.ts` after 017.
> 2. Update `src/model-switch.ts`:
>    - `getCurrentModel(folder)`: read from `getContainerConfig(group.id).model` after looking up the group.
>    - `setModel(folder, model)`: call `updateContainerConfigScalars(group.id, { model })` instead of `updateAgentGroup(group.id, { model })`. Then `materializeContainerJson(group.id)`. Then kill running containers as it does today.
>    - `resolveEffectiveModel` already takes `{ agent_provider, model }` — callers must pass model from container_configs now. Add a helper that reads both fields for callers that have only a folder string.
> 3. Use codegraph to find all readers of `agent_groups.model`:
>    Run `codegraph_callers updateAgentGroup` and inspect each caller's args for `model`. Search `\.model\b` against agent group references. Adapt each reader.
> 4. Update `src/types.ts` `AgentGroup` interface — remove the `model` field.
>
> Verification:
> - `pnpm run build` clean.
> - Create a temp verification script that copies `data/v2.db.backup-pre-pi-20260525` to /tmp, runs migrations, queries `PRAGMA table_info('agent_groups')` and `SELECT agent_group_id, model FROM container_configs WHERE model IS NOT NULL`. Expected: `agent_groups` no longer has a `model` column; `container_configs` has model values for groups that previously had them. Delete the verification script after.
>
> Return: summary of every file modified, migration logic, verification result.

After return, stage all modified files and commit with subject `feat(db): drop agent_groups.model, canonicalize in container_configs (bhalf-7)`.

---

## Task bhalf-8 (parallel): Adapt remaining callers (codegraph-surfaced)

This task was added after codegraph queries surfaced 5 callers the original audit grep missed.

**Agent brief:**

> Adapt 5 additional callers of the old container-config file API to use the DB-backed equivalents in `/Users/admin/projects/nanoclaw`. Identified via `codegraph_callers readContainerConfig` and `codegraph_callers writeContainerConfig`.
>
> Files:
> - `src/channels/playground/api/models.ts` — 3 handlers: `handleGetModels` (line 66), `handlePutModels` (line 118), `handlePutActiveModel` (line 142). All currently call `readContainerConfig` and/or `writeContainerConfig`.
> - `src/channels/playground/api-routes.ts:107` — the `route` function dispatches to these handlers; verify and update imports if needed.
> - `src/claude-md-compose.ts:42` — `composeGroupClaudeMd` calls `readContainerConfig`.
> - `scripts/class-skeleton.ts:222` — `provisionGroup` calls `writeContainerConfig`.
> - `setup/migrate/seed-v2.ts:137` — `seed` function calls `writeContainerConfig`.
>
> Pattern for each file:
> 1. Read sites (`readContainerConfig(folder)`): replace with `materializeContainerJson(agentGroupId)`. Look up agent group ID via `getAgentGroupByFolder(folder)` if the caller only has the folder.
> 2. Write sites (`writeContainerConfig(folder, config)`): replace with `updateContainerConfigScalars(agentGroupId, {...})` for scalar fields and `updateContainerConfigJson(agentGroupId, column, value)` for JSON columns (skills, mcp_servers, packages_apt, packages_npm, additional_mounts). After all updates, call `materializeContainerJson(agentGroupId)` so the on-disk file reflects the change.
> 3. For `scripts/class-skeleton.ts` and `setup/migrate/seed-v2.ts`: seed/migration scripts. They may need to call `createContainerConfig(row)` directly (insert a full row) rather than going through update API. Adapt accordingly.
>
> Constraints:
> - Don't refactor unrelated logic.
> - Preserve all classroom-specific features (playground display logic, seed transformations, etc.).
> - If a script uses `emptyConfig()` or other helpers from the old container-config.ts, replace with appropriate defaults inline.
>
> Verification: `pnpm run build` — all 5 files type-clean.
>
> Return: per-file summary of changes with file:line refs.

After return, stage all 5 modified files and commit with subject `refactor: swap remaining file-config callers to DB API (bhalf-8)`.

---

## Task bhalf-9: Backfill + index.ts startup integration

After bhalf-3 through bhalf-8 all merge and typecheck is clean:

**Files:**
- Create: `src/backfill-container-configs.ts`
- Create: `src/backfill-container-configs.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Copy backfill from upstream**

Copy `/tmp/nanoclaw-upstream/src/backfill-container-configs.ts` to the same path in classroom verbatim. Verify imports resolve in classroom.

- [ ] **Step 2: Wire into src/index.ts startup**

Find where `runMigrations(db)` is called. Immediately after, add an import and call to `backfillContainerConfigs()`. The call is idempotent (skips groups that already have a config row).

- [ ] **Step 3: Write src/backfill-container-configs.test.ts**

Test idempotency and disk-file-to-DB-row translation. Use a throwaway DB, create 2 agent groups with container.json on disk, run backfill, verify rows. Run again, verify no duplicate rows or changes. Cover the default case (no container.json present — should still create empty row).

- [ ] **Step 4: Verify against personal's groups (read-only)**

Personal has 3+ groups with container.json on disk. Test the backfill against a copy. Create `scripts/verify-bhalf-9.ts` that copies personal's `data/v2.db` and `groups/` directory to /tmp, sets `GROUPS_DIR` and `DATA_DIR` env vars to point there, initializes the DB, runs migrations and backfill, then prints the count of rows from `getAllContainerConfigs()`. Run with `pnpm tsx scripts/verify-bhalf-9.ts`. Delete the script after.

Expected: row count matches personal's agent group count.

- [ ] **Step 5: Typecheck + tests**

Run: `pnpm run build` then `pnpm test`. Both clean.

- [ ] **Step 6: Commit**

Stage `src/backfill-container-configs.ts`, `src/backfill-container-configs.test.ts`, `src/index.ts`. Commit with subject `feat(db): backfill container_configs from on-disk container.json at startup (bhalf-9)`.

---

## Task bhalf-10: Full validation

- [ ] **Step 1: Host typecheck + tests**

Run: `pnpm run build && pnpm test`. All green.

- [ ] **Step 2: Container typecheck**

Run: `pnpm tsc -p container/agent-runner/tsconfig.json --noEmit`. Clean (container side unchanged).

- [ ] **Step 3: DB backup before live migration**

Run: `cp data/v2.db data/v2.db.backup-pre-bhalf-$(date +%s)`

- [ ] **Step 4: Restart classroom service**

Run:
```
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-v2-581fefa4.plist
sleep 5
tail -50 logs/nanoclaw.log | grep -E "Migration applied|Backfilled|container_configs"
```

Expected: migrations 016/017/018 logged, backfill count logged.

- [ ] **Step 5: Send test message via playground**

Open http://130.127.162.180:3002, send a chat message to an existing agent group. Verify agent responds normally.

- [ ] **Step 6: Exercise new CLI verbs**

Run:
- `ncl groups list`
- `ncl groups config get --id <one-of-the-group-ids>`
- `ncl groups config update --id <id> --model claude-sonnet-4-5`
- `ncl groups config get --id <id>` — verify the model field updated.

- [ ] **Step 7: Tag phase end**

Run: `git tag phase-bhalf-complete-2026-05-25 -m "Phase B½ container_configs DB migration complete"` then `git log catchup/phase-a-2026-05-25..HEAD --oneline`.

---

## Self-Review checklist

- [ ] All commits build cleanly individually
- [ ] Full test suite green
- [ ] Migrations 016/017/018 applied against real classroom DB without errors
- [ ] Backfill correctly seeded existing agent groups
- [ ] `ncl groups config get/update/...` works for an existing group
- [ ] Existing claude/codex agent groups still spawn and respond
- [ ] No regressions in security fixes from Phase A
- [ ] Tag `phase-bhalf-complete-2026-05-25` set

## Cross-references

- Parent plan: `plans/classroom-upstream-catchup-2026-05-25.md`
- Next plan: `docs/superpowers/plans/2026-05-25-phase-c-pi-port.md`
- Audit: `plans/pi-personal-audit-2026-05-25.md`, `plans/classroom-pre-pi-audit-2026-05-25.md`
- Rollback: tag `pre-pi-catchup-2026-05-25`, DB backup `data/v2.db.backup-pre-pi-20260525`
