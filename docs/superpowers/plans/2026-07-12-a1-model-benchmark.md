# A1 — Agent-Task Model Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `scripts/bench.ts` agent-harness benchmark to measure **MCP tool-use reliability** of the free candidate models via **real pi agent turns**, and produce a comparison report + a default recommendation.

**Architecture:** Reuse `bench.ts`'s proven mechanics — real turns via SSE (`/api/drafts/<folder>/stream` + `POST /messages`), per-system bench-group provisioning, container-kill + continuation-clear between reps, `/api/bench/session` owner auth (`BENCH_MODE=1`, already in `.env`). **Modernize it for the current pi-only harness**: candidate systems become `provider:'pi'` + `model_provider` (`clemson`/`local`); model routing is set in the DB `container_configs` row (which `materializeContainerJson` regenerates `container.json` from at each spawn — direct `container.json` writes are overwritten and must NOT be relied on); tool-use is scored from the session `outbound.db` trace (verified shape below), not the stale SSE `tool_use` count. Add the MCP task set + a reliability report. No production code path changes; nothing auto-updates the default.

**Tech Stack:** Node/pnpm host, TypeScript, `tsx`, `better-sqlite3` to read `outbound.db`, vitest for the scoring unit tests.

## Global Constraints

- **Real agent turns, not raw completions** — every score comes from a real container turn through the actual pipeline (tools + credential proxy), driven exactly as `bench.ts` already does.
- **Headline metric = MCP tool-use reliability:** per MCP task, (a) **tool-invoked** — the expected MCP tool name appears in the turn's `outbound.db` `kind:'trace'` rows; (b) **answer-grounded** — the final reply shares a key value with that tool's result captured in the trace (catches hallucination-despite-tool-call). Plus latency + turn-error.
- **Self-grounded scoring:** ground truth for MCP tasks comes from the tool's own result captured in the trace during that turn — NOT an external call, NOT hardcoded live-data facts (which drift).
- **Roster (free models), exact `model_provider` + `model`:**
  - `model_provider:'clemson'` → `qwen3.6-35b-a3b-fp8`, `qwen3-30b-a3b-instruct-fp8`, `glm-5.1-fp8`
  - `model_provider:'local'` → `Qwen3.6-35B-A3B-UD-MLX-4bit`, `gemma-4-26B-A4B-it-QAT-MLX-4bit`
  - (`'local'` routes to the proxy `/omlx/v1` prefix — there is no `'omlx'` model_provider value. `'clemson'` routes to `/clemson/v1`.)
  - Excluded for latency: `deepseek-v4-pro`, `gptoss-120b`. DGX deferred.
- **Setting a system's model (authoritative path):** `ensureContainerConfig(agentGroupId)` then `updateContainerConfigScalars(agentGroupId, { provider:'pi', model, model_provider })` (from `src/db/container-configs.ts`). The model is baked at container spawn, so after changing it the group's container must be killed (`killContainer` — `bench.ts`'s `clearContinuation` already does this) before the next turn. Do NOT rely on writing `groups/<folder>/container.json` — `materializeContainerJson` regenerates it from the DB at spawn.
- **Verified trace shape** (`data/v2-sessions/<agentGroupId>/<sessionId>/outbound.db`, table `messages_out`):
  - chat reply → `kind='chat'`, `content` = JSON `{"text": "...", ...}` → reply is `.text`.
  - tool call → `kind='trace'`, `content` = `{"type":"pi_event","event":{"type":"tool_execution_start","toolCallId":"...","toolName":"cuassistant-public__search-clemson-classes","args":{...}}}`.
  - tool result → `kind='trace'`, `content` = `{"type":"pi_event","event":{"type":"tool_execution_end","toolCallId":"...","toolName":"...","result":{"content":[{"type":"text","text":"<tool output json string>"}]}}}`.
- **No auto-change:** the report RECOMMENDS a default; it never edits `provision-user.ts` or any group config.
- **No secret read/print/log.** Read only non-secret data (model ids, replies, traces, latency).
- **Cleanup:** tear down every bench group created (kill container, remove group + fs) at the end. Leave `owner_01` and `_default_participant` untouched.
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done. Clean stray `groups/bench_*` dirs at teardown.
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `scripts/bench-mcp-score.ts`** — pure scoring module: `parseTurnRows(rows)` → `{reply, toolCalls:[{name,resultText}], errored}` from `messages_out` rows; `readTurnOutbound(outboundPath, sinceSeq)` DB wrapper; scorers `toolInvoked`, `answerGrounded`, `matchesExpected`. This is the crux — grounded in the verified real trace shape.
- **Create `scripts/bench-mcp-score.test.ts`** — unit tests against a REAL captured trace fixture.
- **Create `scripts/bench-fixtures/mcp-turn.json`** — real `messages_out` rows (chat + tool_execution_start/end) captured from the owner session (controller supplies this in Task 1 Step 1).
- **Create `scripts/bench-prompts-mcp.json`** — the MCP + general task set (same array shape `bench.ts` already loads, extended with an `expectedTool` field for MCP tasks).
- **Modify `scripts/bench.ts`** — replace stale `SYSTEMS` with the pi/`model_provider` roster; fix provisioning to set the DB `container_configs` row (`ensureContainerConfig` + `updateContainerConfigScalars`) instead of relying on `container.json`; add a `--suite mcp` path that loads `bench-prompts-mcp.json` and scores via `bench-mcp-score.ts` reading `outbound.db`; add the MCP-reliability report.
- **Output:** `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md` (the generated report — the deliverable).

---

### Task 1: MCP-reliability scoring module (grounded in a real trace)

**Files:**
- Create: `scripts/bench-mcp-score.ts`, `scripts/bench-mcp-score.test.ts`, `scripts/bench-fixtures/mcp-turn.json`

**Interfaces:**
- Produces:
  - `type ToolCall = { name: string; resultText: string }`
  - `type TurnResult = { reply: string; toolCalls: ToolCall[]; errored: boolean }`
  - `type OutboundRow = { kind: string; content: string }`
  - `parseTurnRows(rows: OutboundRow[]): TurnResult` — last `kind:'chat'` row's `JSON.parse(content).text` is `reply`; for each `kind:'trace'` row, `JSON.parse(content)` → if `.type==='pi_event'` and `.event.type==='tool_execution_start'` record a tool call keyed by `.event.toolCallId` with `name=.event.toolName`; on the matching `tool_execution_end` (same `toolCallId`) set its `resultText` = the joined `.event.result.content[].text`; `errored` = no chat reply present.
  - `readTurnOutbound(outboundPath: string, sinceSeq: number): TurnResult` — opens the DB (`better-sqlite3`, readonly), selects `seq, kind, content FROM messages_out WHERE seq > @sinceSeq ORDER BY seq`, maps to `OutboundRow[]`, calls `parseTurnRows`.
  - `toolInvoked(t: TurnResult, expectedTool: string): boolean` — some `toolCalls[].name` includes `expectedTool`.
  - `answerGrounded(t: TurnResult): boolean` — the reply shares an alphanumeric token of length ≥3 (case-insensitive) with some tool's `resultText`.
  - `matchesExpected(reply: string, expected: string | RegExp): boolean`.

- [ ] **Step 1 (CONTROLLER — already have the data): capture the real fixture**

The controller extracts real `messages_out` rows from the owner session's Fall-2026 exploration (`data/v2-sessions/ag_1783646694218_qht2p4/sess-1783647060183-5f0q56/outbound.db`, seq 585–701) — a contiguous slice containing a `tool_execution_start`/`tool_execution_end` for `cuassistant-public__search-clemson-classes` (result includes `202608`, `Fall 2026`, `Jordan Hall`, `G33`) and the following chat reply (contains `202608`/`Fall 2026`). Written to `scripts/bench-fixtures/mcp-turn.json` as an array of `{seq, kind, content}` objects verbatim from the DB. The implementer treats this file as given.

> The controller provides this file before dispatch. The implementer does NOT capture it and must not guess the shape — it is real rows on disk.

- [ ] **Step 2: Write the failing scorer tests**

Create `scripts/bench-mcp-score.test.ts` using the fixture:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseTurnRows, toolInvoked, answerGrounded, matchesExpected } from './bench-mcp-score.js';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'bench-fixtures/mcp-turn.json'), 'utf8'));

describe('bench-mcp-score', () => {
  it('extracts the reply and the tool call + result from real trace rows', () => {
    const t = parseTurnRows(rows);
    expect(t.reply.length).toBeGreaterThan(0);
    expect(t.errored).toBe(false);
    const call = t.toolCalls.find((c) => c.name.includes('search-clemson-classes'));
    expect(call).toBeTruthy();
    expect(call!.resultText).toContain('202608'); // tool result carried through
  });
  it('toolInvoked matches expected tool-name substring', () => {
    const t = parseTurnRows(rows);
    expect(toolInvoked(t, 'search-clemson-classes')).toBe(true);
    expect(toolInvoked(t, 'get-clemson-room-availability')).toBe(false);
  });
  it('answerGrounded is true when reply shares a value with a tool result', () => {
    expect(answerGrounded(parseTurnRows(rows))).toBe(true);
  });
  it('answerGrounded is false when nothing overlaps', () => {
    const t = { reply: 'zzz nothing here', toolCalls: [{ name: 'x', resultText: '202608 Fall' }], errored: false };
    expect(answerGrounded(t)).toBe(false);
  });
  it('matchesExpected handles general-task checks', () => {
    expect(matchesExpected('{"answer": 42}', /\{\s*"answer"\s*:\s*42\s*\}/)).toBe(true);
    expect(matchesExpected('Alice', 'Alice')).toBe(true);
    expect(matchesExpected('Bob', 'Alice')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run scripts/bench-mcp-score.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `bench-mcp-score.ts`**

Implement `parseTurnRows` (correlate `tool_execution_start`/`end` by `toolCallId`; join `result.content[].text`), `readTurnOutbound` (readonly `better-sqlite3`), and the three scorers exactly as specified in Interfaces. `answerGrounded`: tokenize the reply into `[A-Za-z0-9]{3,}` tokens, lowercase, return true if any appears (as a substring, lowercased) in any tool `resultText`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run scripts/bench-mcp-score.test.ts`
Expected: PASS (5/5).

- [ ] **Step 6: Build + commit**

Run: `pnpm run build` (expected clean).
```bash
git add scripts/bench-mcp-score.ts scripts/bench-mcp-score.test.ts scripts/bench-fixtures/mcp-turn.json
git commit -m "feat(bench): MCP tool-use scoring from real outbound trace"
```

---

### Task 2: Modernize bench.ts for pi/model_provider + wire the MCP suite

**Files:**
- Modify: `scripts/bench.ts`
- Create: `scripts/bench-prompts-mcp.json`

**Interfaces:**
- Consumes: `parseTurnRows`, `readTurnOutbound`, `toolInvoked`, `answerGrounded`, `matchesExpected` from `./bench-mcp-score.js` (Task 1); existing `bench.ts` helpers `obtainSessionCookie`, `sendAndCollect`, `clearContinuation`, HTTP helpers; `ensureContainerConfig`, `updateContainerConfigScalars`, `updateContainerConfigJson` from `../src/db/container-configs.js`; `getAgentGroupByFolder` from `../src/db/agent-groups.js`; `getActiveSessions` from `../src/db/sessions.js`.
- Produces: a `--suite mcp` code path in `bench.ts` that runs the roster × MCP task set and emits the report.

- [ ] **Step 1: Replace the stale SYSTEMS map**

In `bench.ts`, replace the `SYSTEMS` record with the pi/model_provider roster. Each entry: `{ provider: 'pi', model: <id>, modelProvider: 'clemson'|'local', label }`. Keys + values:
- `clemson-qwen36` → `{ provider:'pi', model:'qwen3.6-35b-a3b-fp8', modelProvider:'clemson' }`
- `clemson-qwen3-30b` → `{ provider:'pi', model:'qwen3-30b-a3b-instruct-fp8', modelProvider:'clemson' }`
- `clemson-glm51` → `{ provider:'pi', model:'glm-5.1-fp8', modelProvider:'clemson' }`
- `local-qwen36` → `{ provider:'pi', model:'Qwen3.6-35B-A3B-UD-MLX-4bit', modelProvider:'local' }`
- `local-gemma4` → `{ provider:'pi', model:'gemma-4-26B-A4B-it-QAT-MLX-4bit', modelProvider:'local' }`

Update the `SYSTEMS` value type to `{ provider: string; model: string; modelProvider: string; label: string }`.

- [ ] **Step 2: Fix provisioning to set the DB container_configs row**

In `provisionBenchGroup` / `createBenchGroupViaDb`: after the agent group exists, resolve `agentGroupId` via `getAgentGroupByFolder(folder)`, then call `ensureContainerConfig(agentGroupId)` and `updateContainerConfigScalars(agentGroupId, { provider: 'pi', model: system.model, model_provider: system.modelProvider })`. Seed the MCP tools by copying the `owner_01` group's `mcp_servers` and `skills` container-config values into the bench group's row via `updateContainerConfigJson` (read owner's row with the existing `getContainerConfig`/equivalent in `src/db/container-configs.ts`). The existing `container.json`/`CLAUDE.md` file copy may stay for scaffolding, but model routing now comes from the DB.

> Rationale for the reviewer: `materializeContainerJson` (container-runner.ts:136) regenerates `container.json` from the DB at spawn, so the DB row — not the file — is authoritative for `model`/`model_provider`/`mcp_servers`.

- [ ] **Step 3: Add the MCP task set**

Create `scripts/bench-prompts-mcp.json` — an array of `{ id, kind:'single', prompt, expectedTool?, gate, expected }`. MCP tasks (`expectedTool` set, gate `'mcp'`):
- `class-search` → prompt "What sections of GC 1010 are offered in Fall 2026? List section numbers and CRNs." → `expectedTool:"search-clemson-classes"`.
- `section-details` → "Where and when does GC 1010 section 001 meet in Fall 2026?" → `expectedTool:"section-details"`.
- `room-availability` → "Is Jordan Hall G33 free Friday afternoon in Fall 2026?" → `expectedTool:"room-availability"`.
- `curriculum` → a gc-wiki-answerable prereq/content question → `expectedTool:"gc-wiki"` (tool substring adjusted to the seeded curriculum server prefix confirmed at run time).
General tasks (no `expectedTool`):
- `attach-max` → gate `'contains'`, "Given this CSV, which name has the max score? Reply with just the name.\nname,score\nAlice,91\nBob,77" → expected `"Alice"`.
- `strict-format` → gate `'json'`, 'Reply with exactly {"answer": 42} and nothing else.' → expected `{"answer":42}`.

> The exact seeded MCP server/tool prefixes are confirmed by the controller against the provisioned bench group before the live run; `toolInvoked` uses substring match so the short tool name suffices.

- [ ] **Step 4: Add the `--suite mcp` run path + scoring**

Add `--suite <default|mcp>` to `parseArgs` (default `default`). When `mcp`: load `bench-prompts-mcp.json`; resolve the bench group's session `outbound.db` path once per system (same resolution `clearContinuation` uses: `getAgentGroupByFolder` → `getActiveSessions` filtered by `ag.id` → `data/v2-sessions/<ag.id>/<sess.id>/outbound.db`). For each `(system × task)`: read the session's current max `seq` (small `SELECT max(seq)` query, or 0 if the DB/rows don't exist yet) as `sinceSeq`, drive the turn with `sendAndCollect`, then call `readTurnOutbound(path, sinceSeq)` (re-resolve the session path if it didn't exist before the first turn). Score: MCP tasks pass = `toolInvoked(turn, expectedTool) && answerGrounded(turn)`; general tasks pass = `matchesExpected(reply, expected)`. Record `{system, task, toolPass, answerPass, latencyMs (from sendAndCollect), errored, reply}`. Reuse `clearContinuation` between tasks so each is a fresh thread on the new model.

- [ ] **Step 5: Typecheck + gate the code path**

Run `pnpm run build` (expected clean). Confirm `pnpm exec tsx scripts/bench.ts --suite mcp --systems clemson-qwen36 --help`-equivalent arg parsing (dry, no live turn) resolves without throwing on unknown args. The live one-system smoke run is controller-run in Task 3; the implementer only ensures the `--suite mcp` path compiles and is complete.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench.ts scripts/bench-prompts-mcp.json
git commit -m "feat(bench): pi/model_provider systems + MCP reliability suite"
```

---

### Task 3: Full live run + report (CONTROLLER-run)

**Files:** Modify `scripts/bench.ts` (report rendering for `--suite mcp`); Create `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md` (generated).

- [ ] **Step 1: Add MCP report rendering**

After the `--suite mcp` loop, render a markdown report: a **systems × tasks** matrix (MCP cell `tool✓/✗ ans✓/✗`, general cell `✓/✗`), a per-system summary (**MCP-reliability** = fraction of MCP tasks with tool✓ AND ans✓; overall pass count; median latency; error count), the reply text per (system,task) in an appendix for spot-check, and a **Recommendation** (best free-campus default for MCP; whether the current `qwen3.6-35b-a3b-fp8` default suffices; best fully-private local option; fallback ordering). Write to `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md`.

- [ ] **Step 2: Run the full benchmark live (CONTROLLER)**

Ensure the host is running + `BENCH_MODE=1`. First a one-system smoke run (`--suite mcp --systems clemson-qwen36 --reps 1`); on success, the full roster `--systems clemson-qwen36,clemson-qwen3-30b,clemson-glm51,local-qwen36,local-gemma4 --reps 1` serially (real container turns; expect tens of minutes). Confirm it completes and writes the report.

- [ ] **Step 3: Review results + recommendation**

Read the generated report; confirm the matrix is populated and the reliability scores + recommendation follow from the data. If the current default `qwen3.6-35b-a3b-fp8` is not the top free MCP performer, state that clearly and name the better default — but change NO config.

- [ ] **Step 4: Teardown + commit**

Tear down every `bench_*` group created (kill container, delete group row + `groups/bench_*` fs). Commit:
```bash
git add scripts/bench.ts docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md
git commit -m "feat(bench): MCP-reliability report + default recommendation"
```

---

## Self-Review

**1. Spec coverage:**
- Real pi agent turns via re-pointed bench groups → Task 2 (reuses bench.ts SSE driving).
- MCP tool-use reliability (tool-invoked + answer-grounded), self-grounded from the trace → Task 1 scorers (grounded in a real fixture) + Task 2 Step 4 scoring.
- Task set (4 MCP + 2 general) → `bench-prompts-mcp.json` (Task 2 Step 3).
- Roster (Clemson ×3 clemson, local MLX ×2) with correct `model_provider` (`clemson`/`local`) → Task 2 Step 1 + Global Constraints.
- Latency + error scored → Task 2 Step 4; report → Task 3.
- Report + recommendation, no auto-change → Task 3 (explicitly changes no config).
- DB-authoritative model routing (`ensureContainerConfig`+`updateContainerConfigScalars`, kill container) → Task 2 Step 2 + Global Constraints.

**2. Placeholder scan:** No TBD/TODO. The only run-time-confirmed detail — the exact seeded curriculum tool prefix — is handled by substring `toolInvoked` matching + a controller confirmation before the live run, not a code placeholder.

**3. Type consistency:** `TurnResult`/`ToolCall`/`OutboundRow` and `parseTurnRows`/`readTurnOutbound`/`toolInvoked`/`answerGrounded`/`matchesExpected` are defined in Task 1 and consumed unchanged in Task 2; `SYSTEMS` gains `modelProvider` (Task 2 Step 1) and every consumer (`provisionBenchGroup`) is updated in the same task; model ids + `model_provider` values (`clemson`/`local`) match Global Constraints verbatim; the report path is consistent across Task 3 steps.
