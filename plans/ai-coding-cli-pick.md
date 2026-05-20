# AI-coding-CLI Picker — Integration Plan

## Goal

Wire the `setup/lib/ai-coding-cli/` registry (already committed) into the existing setup flow so:

1. The setup-time CLI invocations (handoff on failure, headless utility) go through the registry instead of hardcoded `claude` binary calls.
2. The user is asked once which CLI to use (Claude Code, OpenAI Codex, …), with the choice persisted to `.env` as `NANOCLAW_AI_CODING_CLI`.
3. README Quick Start reflects dual-CLI support honestly.

## Three independent choices — do not conflate

NanoClaw has three CLI/provider knobs that look related but are deliberately separate. The picker this plan adds is **only** about #2:

| # | Choice | What runs it | Affects | How it's switched |
|---|---|---|---|---|
| 1 | **Agent runtime backend** (`agent_groups.agent_provider`) | Per-session container; Felix calls Anthropic API or OpenAI App-Server | Every chat with the agent — model speed, cost, feature parity | `/provider <name>` Telegram admin command (already shipped) |
| 2 | **AI-coding-CLI helper** (`NANOCLAW_AI_CODING_CLI` env var) | Host, only when a setup step fails or for headless utility (e.g. tz parsing) | First-time setup + step-failure handoff. Does NOT touch the running agent. | Picker on first run; `--reconfigure-cli` flag (Phase F); manual `.env` edit |
| 3 | **Operator's personal dev tool** | Your laptop while editing code | You, the developer | Your own choice — NanoClaw doesn't know or care |

**The canonical mixed case** is fully supported and not coupled anywhere: `NANOCLAW_AI_CODING_CLI=claude` + `agent_provider=codex` (operator likes Claude Code for setup debugging but the agent uses OpenAI for runtime). The picker in Phase D MUST NOT read `agent_provider`, and `/provider` MUST NOT touch `NANOCLAW_AI_CODING_CLI`. Don't add "convenience" cross-defaults.

## Current state (as of commit `bb26617`)

**Done — framework + adapters:**

| File | Purpose |
|---|---|
| `setup/lib/ai-coding-cli/types.ts` | `AiCodingCli` interface (binary, isInstalled, isAuthenticated, installScript, headless(prompt), handoff(prompt)) + `SpawnArgs` (argv, stdin, output) |
| `setup/lib/ai-coding-cli/claude.ts` | `claudeCli` — Claude Code adapter |
| `setup/lib/ai-coding-cli/codex.ts` | `codexCli` — OpenAI Codex adapter (`codex exec` headless, `codex [PROMPT]` handoff) |
| `setup/lib/ai-coding-cli/index.ts` | Registry with `listAiCodingClis()`, `getAiCodingCli(name)`, `resolveAiCodingCli()` |
| `setup/lib/ai-coding-cli/index.test.ts` | 11 tests covering both adapters' argv shapes and registry behavior |

**Selection precedence in `resolveAiCodingCli()`:**

1. `NANOCLAW_AI_CODING_CLI` env var (if set + adapter exists + installed)
2. First registered adapter that's installed (Claude first)
3. `null` if nothing works

**Untouched (still hardcodes `claude` binary) — work for this plan:**

| File | Hardcoded calls | Consumers |
|---|---|---|
| `setup/lib/tz-from-claude.ts` | `execSync('command -v claude')` (line 24), `spawn('claude', ['-p', ...])` (line 89) | `setup/auto.ts` |
| `setup/lib/claude-handoff.ts` | `execSync('command -v claude')` (line 160), `spawn('claude', ...)` (lines 94, 259) | `setup/auto.ts`, `setup/lib/runner.ts`, `setup/lib/windowed-runner.ts`, `setup/migrate.ts`, `setup/channels/teams.ts` |
| `setup/lib/claude-assist.ts` | `execSync('command -v claude')` (line 137), `claude auth status` (146), `setup/install-claude.sh` invocation (164), `spawn('claude', ...)` (388) | `setup/migrate.ts`, transitively used by `claude-handoff.ts` |
| `setup/install-claude.sh` | Pure bash; only relevant for Claude. Codex has no scriptable installer in this fork. | called by `claude-assist.ts` |
| `nanoclaw.sh` | No direct Claude reference; the failure handoff happens via `setup:auto` which uses the libs above | n/a |
| `README.md` Quick Start | Says "Claude Code is invoked automatically" | n/a |

**Tests baseline:** `pnpm test` → 466/466 passing.

## Phases

Each phase ends with `pnpm run build` + `pnpm test` clean and a focused commit. **Do not collapse phases** — incremental commits make rollback cheap if a setup-flow regression surfaces only on real-world install.

---

### Phase A — Refactor `tz-from-claude.ts` (smallest consumer; warm-up)

**Why first:** smallest file, single consumer, clear win/loss boundary. If this works, the bigger refactors follow the same shape.

**Files:**

- Rename `setup/lib/tz-from-claude.ts` → `setup/lib/tz-from-cli.ts` (keep file name honest about what it does)
- Update import in `setup/auto.ts:54`

**Changes:**

1. New file replaces hardcoded `claude` invocation:
   ```ts
   import { resolveAiCodingCli } from './ai-coding-cli/index.js';

   export function aiCodingCliAvailable(): boolean {
     return resolveAiCodingCli() !== null;
   }

   export async function resolveTimezoneViaCli(userInput: string): Promise<string | null> {
     const cli = resolveAiCodingCli();
     if (!cli) return null;
     const spawnArgs = cli.headless(`Convert "${userInput}" to a single IANA tz string. Reply ONLY the zone, nothing else.`);
     // ... existing spawn logic, replacing 'claude' with cli.binary and ['-p', ...] with spawnArgs.args
   }
   ```

2. Rename exports:
   - `claudeCliAvailable` → `aiCodingCliAvailable`
   - `resolveTimezoneViaClaude` → `resolveTimezoneViaCli`

3. Update `setup/auto.ts:54` import + call sites.

**Verification:**

- `pnpm exec tsc --noEmit` clean
- `pnpm test` 466/466
- Manual: temporarily drop `claude` from PATH (e.g. `PATH=/usr/bin pnpm run setup:auto`), confirm tz resolution falls through to codex if installed.

**Commit:** `refactor(setup): tz-from-cli — use ai-coding-cli registry instead of hardcoded claude`

---

### Phase B — Refactor `claude-handoff.ts` → `cli-handoff.ts`

**Why before assist:** handoff is what the user sees on step failure. Assist is the underlying mechanism. Fixing handoff first lets us validate the picker UX with one failure path.

**Files:**

- Rename `setup/lib/claude-handoff.ts` → `setup/lib/cli-handoff.ts`
- Update imports in: `setup/auto.ts:42`, `setup/lib/runner.ts:21`, `setup/lib/windowed-runner.ts:21`, `setup/migrate.ts:33`, `setup/channels/teams.ts:41`

**Changes:**

1. The internal `isClaudeUsable()` helper (line 158) becomes `isAiCodingCliUsable()` and consults `resolveAiCodingCli()`.
2. `offerClaudeHandoff(ctx)` becomes `offerAiCodingCliHandoff(ctx)` — internally:
   ```ts
   const cli = resolveAiCodingCli();
   if (!cli) return false;
   const spawn = cli.handoff(buildSystemPrompt(ctx));
   const child = spawn(cli.binary, spawn.args, { stdio: [spawn.stdin, spawn.output, spawn.output] });
   ```
3. `offerClaudeOnFailure` → `offerAiCodingCliOnFailure` (same semantic)
4. Public exports updated (and the 5 consumer imports renamed).
5. The Markdown / TUI prompts in `buildSystemPrompt` and `buildFailureSystemPrompt` should be **CLI-agnostic** in wording — no "Claude Code" hardcoded strings. The system prompt should reference what the failure was, not which CLI is reading it.

**Edge case: prompt format differences.**

- Claude Code's `claude [PROMPT]` interprets the prompt as the opening user message in the TUI.
- Codex's bare `codex [PROMPT]` does the same.
- Both spawn an interactive session that exits cleanly when user types `/exit` (Claude) or `Ctrl-C` / `:q` style (Codex). No special handling needed at the spawn level.

**Verification:**

- Build + tests clean.
- Manual: artificially fail a setup step (set `NANOCLAW_SKIP_FORCE_FAIL=1` or similar — see `nanoclaw.sh:NANOCLAW_SKIP`), confirm picker → handoff happens via the chosen CLI.

**Commit:** `refactor(setup): cli-handoff — registry-aware setup-step handoff`

---

### Phase C — Refactor `claude-assist.ts` → `cli-assist.ts`

**Files:**

- Rename `setup/lib/claude-assist.ts` → `setup/lib/cli-assist.ts`
- Update imports in `setup/migrate.ts:32`, internal use from `cli-handoff.ts`

**Changes:**

1. `isClaudeInstalled()`, `isClaudeAuthenticated()`, `ensureClaudeReady()` become `isAiCodingCliInstalled()`, `isAiCodingCliAuthenticated()`, `ensureAiCodingCliReady()` — all consult `resolveAiCodingCli()`.
2. `ensureAiCodingCliReady()`'s install-script invocation respects the adapter's `installScript` field:
   ```ts
   const cli = resolveAiCodingCli();
   if (cli?.installScript) {
     const code = spawnSync('bash', [cli.installScript], { ... });
   } else {
     // No scriptable installer; tell the user to install manually
     return false;
   }
   ```
3. `offerClaudeAssist(ctx)` → `offerAiCodingCliAssist(ctx)`. The pre-built `${binary} ...` command line that's offered to the user (the editable pre-fill) needs to be rebuilt from the chosen CLI's adapter shape.

**Edge case: STEP_FILES + BIG_PICTURE_FILES context lists.**

These are file lists that get read and pasted into the prompt for context. They're CLI-agnostic — same lists work for any CLI. Keep as-is.

**Verification:** same shape as Phase B.

**Commit:** `refactor(setup): cli-assist — registry-aware setup helper`

---

### Phase D — Picker prompt + `.env` persistence

**Where:** `setup/auto.ts`, near the start of the flow before any step that might invoke a CLI.

**Behavior:**

1. **Already-configured path:** if `NANOCLAW_AI_CODING_CLI` is set (env or `.env`), validate it's installed; if so, skip the prompt.
2. **Auto-pick path:** exactly one CLI installed → no prompt; just persist `NANOCLAW_AI_CODING_CLI=<that-one>` and continue.
3. **Picker path:** zero or two-or-more installed → ask via `@clack/prompts` `select`:
   ```ts
   const installed = listAiCodingClis().filter((c) => c.isInstalled());
   if (installed.length === 0) {
     // Offer to install Claude Code via setup/install-claude.sh; otherwise tell user
     // to install one of the listed CLIs and re-run setup.
   } else if (installed.length === 1) {
     // Auto-pick, persist, continue silently.
   } else {
     const choice = await select({
       message: 'Which coding-assistant CLI should setup use for diagnostics?',
       options: installed.map((c) => ({ value: c.name, label: c.displayName })),
     });
     // Persist to .env
   }
   ```
4. **Persistence:** append/update the `.env` line `NANOCLAW_AI_CODING_CLI=<name>`. Reuse the same env-write helper the rest of `setup/auto.ts` uses for `TZ` etc. (search `setup/auto.ts` for `writeEnvVar` or similar).

**Verification:**

- Run `bash nanoclaw.sh` end-to-end from a clean machine that has both CLIs installed. Picker shows; choice persists; failure handoff uses the chosen CLI.
- Then re-run setup; picker is skipped (already configured).
- Then `unset NANOCLAW_AI_CODING_CLI` + `sed -i '/^NANOCLAW_AI_CODING_CLI=/d' .env` + re-run; picker shows again.

**Commit:** `feat(setup): picker prompt for AI coding CLI (Claude Code or Codex)`

---

### Phase E — README + docs update

**Files:**

- `README.md` Quick Start section
- `AGENTS.md` — already mentions both Claude Code and Codex; verify it still reads correctly after the rename
- `docs/setup-flow.md` if it exists — check for stale `claude-handoff` / `claude-assist` references

**README change** (replacing the previously-suggested rewrite from this session):

```markdown
## Quick Start

```bash
git clone https://github.com/chiptoe-svg/nanoclaw_gccourse.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` walks you from a fresh machine to a named agent you can message. It installs Node, pnpm, and Docker if missing, configures the local credential proxy, builds the agent container, and pairs your first Telegram chat. If a step fails, your chosen coding-assistant CLI (Claude Code or OpenAI Codex; setup asks which on first run) is invoked automatically to diagnose and resume from where it broke.

After setup, opt into the optional pieces this fork is built around:

- `/add-admintools` — Telegram admin commands (`/auth`, `/model`, `/provider`)
- `/init-first-agent` — bootstrap your first agent and pair it to a Telegram chat
- `/add-karpathy-llm-wiki` — persistent wiki knowledge base per agent group
- `/add-classroom` — provision a multi-tier class
- Other channels via `/add-discord`, `/add-slack`, `/add-whatsapp`, etc.
```

**Commit:** `docs(readme): mention dual-CLI setup support (Claude Code or Codex)`

---

### Phase F — Post-setup switching

**Why this exists:** Phase D persists `NANOCLAW_AI_CODING_CLI` once and never re-prompts. If the user installs Codex after setup and wants to switch, or installs both later and changes their mind, there's no clean path. The user could manually edit `.env`, but that's not discoverable and easy to typo.

**Note on scope:** this is *only* about the AI-coding CLI choice (what runs on setup-step failure). It is NOT the LLM backend `/provider` switcher — that already exists as a Telegram admin command and is unrelated.

**Three options, ship at least one:**

1. **CLI flag — minimum viable.** Add a `--reconfigure-cli` flag to `setup/auto.ts` that re-runs just the picker phase, then exits. User invocation: `pnpm exec tsx setup/auto.ts --reconfigure-cli`. ~15 minutes of work; no new UI surface; the existing `setup:auto` arg parser already exists in `nanoclaw.sh`.

2. **`/ai-coding-cli` Telegram admin command** — ship as a fourth tool in the `add-admintools` skill. User runs `/ai-coding-cli` to see the current choice + list installed CLIs, `/ai-coding-cli codex` to switch. Same shape as `/provider` and `/model`. Persists to `.env` and confirms in chat. ~1 hour; consistent with the existing admin-command pattern.

3. **Auto re-prompt when the persisted CLI becomes uninstalled** — `resolveAiCodingCli()` already falls back when the configured one is missing; extend the picker logic to also trigger when running `setup:auto` interactively if the persisted CLI is gone, so the user is asked once instead of getting silent fallback. Implicitly handled by Phase D's "configured but not installed" path; explicit prompt is one branch of code.

**Recommendation: do #1 + #3 in this plan, and add #2 as a separate `add-admintool-ai-coding-cli` skill in a follow-up commit** if the operator-UX win seems worth it.

**File changes for #1 + #3:**

- `setup/auto.ts` — handle `--reconfigure-cli` arg (search for the existing `process.argv` parsing; add one branch); inside the picker logic from Phase D, also re-prompt when `configured && !cli.isInstalled()` (with a warning line).
- `nanoclaw.sh` — document the flag in the script's header comment (`# Reconfigure CLI: pnpm exec tsx setup/auto.ts --reconfigure-cli`).
- README — add a sentence about how to switch.

**Verification:**

- `pnpm exec tsx setup/auto.ts --reconfigure-cli` → just shows the picker, persists, exits 0.
- Set `NANOCLAW_AI_CODING_CLI=mystery-cli` (a name no adapter knows) and rerun setup → re-prompts.
- Set `NANOCLAW_AI_CODING_CLI=codex`, uninstall codex → re-prompts on next setup run with a "configured CLI not installed" warning.

**Commit:** `feat(setup): --reconfigure-cli flag + auto-re-prompt on missing CLI`

---

### Phase G — End-to-end smoke test

Not a commit — a manual verification step before merging to origin/main.

**Test matrix:**

| Scenario | Expected |
|---|---|
| Fresh clone, no CLI installed | Setup detects, offers to run `install-claude.sh`. User declines → setup tells them to install one and re-run. |
| Only Claude installed | No picker; auto-picks Claude; persists `NANOCLAW_AI_CODING_CLI=claude`. |
| Only Codex installed | No picker; auto-picks Codex; persists `NANOCLAW_AI_CODING_CLI=codex`. Failure handoff invokes `codex [PROMPT]`. |
| Both installed, first run | Picker shows; user picks one; persists choice. |
| Both installed, second run | No picker; uses persisted choice. |
| `NANOCLAW_AI_CODING_CLI=codex` in env, only Claude installed | Falls back to Claude; warns about misconfig but doesn't fail. |
| Step failure during setup | Handoff happens via chosen CLI; user types `/exit` or equivalent; setup resumes. |

If any of these surface a bug, file as a follow-up commit before announcing the feature.

---

## Estimated effort

- Phase A: 30 min
- Phase B: 1 hour
- Phase C: 1 hour
- Phase D: 1 hour (picker UX + env-write helper hookup)
- Phase E: 15 min
- Phase F: 30 min (`--reconfigure-cli` flag + auto-re-prompt)
- Phase G: 30 min manual smoke test

**Total: ~4.5 hours of focused work.** Should be doable in one fresh session.

## Resumability cues for a future Claude

- The framework commit is `bb26617` on `main`.
- This plan file (`plans/ai-coding-cli-pick.md`) is the source of truth for what's left.
- After each phase commit, tick the corresponding `[x]` box below.
- If you find a phase has subtle complications not captured here, **update this file before continuing** so the next session inherits the discovery.

## Progress

- [x] Framework: `setup/lib/ai-coding-cli/` registry + Claude + Codex adapters + tests
- [x] Phase A: `tz-from-claude.ts` → `tz-from-cli.ts` (registry-aware)
- [x] Phase B: `claude-handoff.ts` → `cli-handoff.ts`
- [x] Phase C: `claude-assist.ts` → `cli-assist.ts` (also: AiCodingCli.headless gained `tools?: boolean` opt; dropped Claude-specific stream-json UI and --resume session for cross-CLI uniformity)
- [x] Phase D: Picker prompt + `.env` persistence
- [x] Phase E: README + docs update
- [x] Phase F: `--reconfigure-cli` flag + auto-re-prompt when persisted CLI is uninstalled (the auto-re-prompt was already covered by Phase D's stale-config fall-through)
- [x] Phase G: End-to-end smoke matrix — programmatic coverage of the
      resolver matrix landed in `setup/lib/ai-coding-cli/resolve.test.ts`
      (11 tests); destructive-scenario items (uninstall a CLI, force a
      setup failure) deferred to fresh-install verification with the
      matrix tracked in `plans/upstream-pr-prep.md` §1.
