# A1 — Agent-Task Model Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a host-side benchmark harness that drives **real pi agent turns** against a scratch agent group re-pointed at each candidate free model, scores **MCP tool-use reliability** (did it call the tool, from the outbound trace; is the answer grounded in the tool's result) + latency, and produces a comparison report + a default recommendation.

**Architecture:** A Node script (`scripts/model-benchmark/`) reuses the running server: it re-points ONE scratch agent group's `container_config` model per candidate (restarting its container), POSTs each task to `/api/drafts/<folder>/messages`, then reads that session's `outbound.db` (`messages_out`: `kind:'chat'` = final reply, `kind:'trace'` = pi-event rows carrying tool calls + tool results). Scoring self-grounds from the trace — no external ground-truth service. Runs serially against the live host; produces a markdown report. No production code path changes; nothing auto-updates the default.

**Tech Stack:** Node/pnpm host, TypeScript, `tsx` for the script, `better-sqlite3` (via the in-tree `scripts/q.ts` pattern or direct) to read `outbound.db`, vitest for the parser/scorer unit tests.

## Global Constraints

- **Real agent turns, not raw completions** — every score comes from a real container turn through the actual pipeline (tools + credential proxy).
- **Headline metric = MCP tool-use reliability:** per MCP task, (a) **tool-invoked** — the expected MCP tool appears in the outbound `kind:'trace'` rows; (b) **answer-grounded** — the final reply shares a key value with that tool's result in the trace (catches hallucination-despite-tool-call). Plus latency + turn-error.
- **Self-grounded scoring:** ground truth for MCP tasks comes from the tool's own result captured in the trace during that turn — NOT an external call, NOT hardcoded live-data facts (which drift).
- **Roster (free models):** `model_provider:'clemson'` → `qwen3.6-35b-a3b-fp8`, `qwen3-30b-a3b-instruct-fp8`, `glm-5.1-fp8`; `model_provider:'omlx'` → `Qwen3.6-35B-A3B-UD-MLX-4bit`, `gemma-4-26B-A4B-it-QAT-MLX-4bit`. (deepseek-v4-pro, gptoss-120b excluded for latency; DGX deferred.)
- **Model routing:** `clemson` → proxy `/clemson/v1`, `omlx` → `/omlx/v1` (already wired in `container/agent-runner/src/providers/pi-model.ts`). Setting a group's model is `updateContainerConfigScalars(agentGroupId, { model, model_provider })`; the model is baked at container spawn, so after changing it the group's container must be recycled before the next turn.
- **No auto-change:** the report RECOMMENDS a default; it never edits `provision-user.ts` or any group.
- **No secret read/print/log.** Read only non-secret data (model ids, replies, traces, latency).
- **Cleanup:** the harness uses ONE scratch agent group, torn down at the end (token revoked, group + fs deleted, container stopped) — mirror prior canary teardown.
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done. Clean stray `groups/` fixture dirs (leave `_default_participant`, `owner_01`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `scripts/model-benchmark/parse-turn.ts`** — pure functions: read a session's `outbound.db` for one turn and extract `{ reply, toolCalls: [{name, resultText}], errored }`; the scorers (`toolInvoked`, `answerGrounded`, `matchesExpected`).
- **Create `scripts/model-benchmark/parse-turn.test.ts`** — unit tests against a REAL captured trace fixture.
- **Create `scripts/model-benchmark/fixtures/mcp-turn.json`** — a real outbound `messages_out` dump from one MCP-tool turn (captured in Task 1 Step 1), so the parser is grounded in the real trace shape, not guessed.
- **Create `scripts/model-benchmark/roster.ts`** — the candidate list `[{label, model, modelProvider, tier}]` and the task set `[{id, prompt, kind:'mcp'|'general', expectedTool?, expected?, files?, scorer}]`.
- **Create `scripts/model-benchmark/run.ts`** — the runner: for each model, re-point the scratch group + recycle its container, drive each task turn, read+score via `parse-turn`, collect results; then render the markdown report.
- **Output:** `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md` (the generated report — the deliverable).

---

### Task 1: Outbound-turn parser + scorers (grounded in a real trace)

**Files:**
- Create: `scripts/model-benchmark/parse-turn.ts`, `scripts/model-benchmark/parse-turn.test.ts`, `scripts/model-benchmark/fixtures/mcp-turn.json`

**Interfaces:**
- Produces:
  - `type ToolCall = { name: string; resultText: string }`
  - `type TurnResult = { reply: string; toolCalls: ToolCall[]; errored: boolean }`
  - `readTurn(outboundDbPath: string, sinceIso: string): TurnResult` — read all `messages_out` rows with `timestamp >= sinceIso`, take the last `kind:'chat'` row's `content.text` as `reply`, parse every `kind:'trace'` row's `content` (`{type:'pi_event', event}`) to extract tool calls (name + result), set `errored` if no chat reply appeared.
  - `toolInvoked(t: TurnResult, expectedTool: string): boolean` — a tool call whose `name` contains `expectedTool` exists.
  - `answerGrounded(t: TurnResult): boolean` — the `reply` shares a non-trivial token (e.g. a number/code ≥3 chars) with some tool's `resultText`.
  - `matchesExpected(reply: string, expected: string | RegExp): boolean` — for general tasks.

- [ ] **Step 1: Capture a REAL MCP-tool trace fixture (grounding step)**

Drive one MCP turn on the running server and dump the raw outbound rows, so the parser targets the actual shape. Provision a throwaway group (or reuse an owner turn), send an MCP question ("What sections of GC 1010 are offered in Fall 2026?"), wait for the reply, then dump that session's `messages_out`:

```bash
# after driving one MCP turn to a group whose session dir is $SESS:
pnpm exec tsx scripts/q.ts "$SESS/outbound.db" \
  "SELECT seq, kind, substr(content,1,4000) AS content, timestamp FROM messages_out ORDER BY seq DESC LIMIT 40;" \
  > /tmp/raw-trace.txt
```
Inspect `/tmp/raw-trace.txt`: find the `kind:'trace'` rows, parse a couple of `content` JSON blobs (`{type:'pi_event', event:{...}}`), and identify **(a)** the event field that names the tool called (e.g. `event.name`, or nested under a `toolCall`/`tool_use` object) and **(b)** the field carrying the tool's RESULT text. Save a representative slice (the trace rows for one MCP turn + the final chat row) as `scripts/model-benchmark/fixtures/mcp-turn.json` (an array of `{kind, content, timestamp}` objects, verbatim from the DB). Record the exact tool-name and tool-result field paths in the test + a comment in `parse-turn.ts`.

> This step resolves the spec's open item. Do NOT write the parser before capturing the fixture — the pi-event shape must come from a real trace, not a guess. If the trace does not carry tool RESULTS (only calls), fall back: `answerGrounded` becomes "reply is non-empty and the tool was invoked", and note the limitation in the report.

- [ ] **Step 2: Write the failing parser/scorer tests**

Create `scripts/model-benchmark/parse-turn.test.ts` using the captured fixture:

```ts
import { describe, it, expect } from 'vitest';
import { readTurnFromRows, toolInvoked, answerGrounded, matchesExpected } from './parse-turn.js';
import fixture from './fixtures/mcp-turn.json'; // array of {kind, content, timestamp}

describe('parse-turn', () => {
  it('extracts the reply and the tool call(s) from a real MCP turn', () => {
    const t = readTurnFromRows(fixture as any);
    expect(t.reply.length).toBeGreaterThan(0);
    expect(t.errored).toBe(false);
    // the fixture turn called the scheduling search tool — assert its name is captured
    expect(t.toolCalls.some((c) => c.name.includes('clemson-classes') || c.name.includes('search'))).toBe(true);
  });
  it('toolInvoked matches the expected tool name substring', () => {
    const t = readTurnFromRows(fixture as any);
    expect(toolInvoked(t, 'search-clemson-classes')).toBe(true);
    expect(toolInvoked(t, 'get-clemson-room-availability')).toBe(false);
  });
  it('answerGrounded is true when the reply shares a value with a tool result', () => {
    const t = readTurnFromRows(fixture as any);
    expect(answerGrounded(t)).toBe(true);
  });
  it('matchesExpected handles the general-task checks', () => {
    expect(matchesExpected('{"answer": 42}', /\{\s*"answer"\s*:\s*42\s*\}/)).toBe(true);
    expect(matchesExpected('Alice', 'Alice')).toBe(true);
    expect(matchesExpected('Bob', 'Alice')).toBe(false);
  });
});
```

> `readTurnFromRows(rows)` is the pure core; `readTurn(dbPath, sinceIso)` is a thin wrapper that queries the DB then calls it — keep the DB read out of the unit test.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run scripts/model-benchmark/parse-turn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `parse-turn.ts`**

Write `parse-turn.ts` with `readTurnFromRows(rows)`, `readTurn(dbPath, sinceIso)` (opens the DB with `better-sqlite3`, selects `id, seq, kind, content, timestamp` where `timestamp >= sinceIso` order by seq, calls `readTurnFromRows`), and the three scorers. Extract tool name + result using the EXACT field paths found in Step 1 (documented in a comment). `content` for chat rows is `JSON.parse(content).text`; for trace rows `JSON.parse(content).event` → tool lifecycle. `answerGrounded`: tokenize the reply into alphanumeric tokens ≥3 chars, return true if any appears (case-insensitive) in any tool's `resultText`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run scripts/model-benchmark/parse-turn.test.ts`
Expected: PASS.

- [ ] **Step 6: Build + commit**

Run: `pnpm run build` (expected clean; scripts are `tsx`-run but the test compiles).
```bash
git add scripts/model-benchmark/parse-turn.ts scripts/model-benchmark/parse-turn.test.ts scripts/model-benchmark/fixtures/mcp-turn.json
git commit -m "feat(benchmark): outbound-turn parser + scorers grounded in a real MCP trace"
```

---

### Task 2: Roster + task set + the runner (proven on one model)

**Files:**
- Create: `scripts/model-benchmark/roster.ts`, `scripts/model-benchmark/run.ts`

**Interfaces:**
- Consumes: `readTurn`, `toolInvoked`, `answerGrounded`, `matchesExpected` from `./parse-turn.js` (Task 1).
- Produces (in `roster.ts`):
  - `ROSTER: Array<{ label: string; model: string; modelProvider: 'clemson'|'omlx'; tier: string }>` — the 5 candidates.
  - `TASKS: Array<{ id: string; prompt: string; files?: Array<{name,mimeType,base64}>; score: (t: TurnResult) => { toolPass?: boolean; answerPass: boolean } }>` — the 5 MCP tasks (each `score` uses `toolInvoked(t, '<tool>') && answerGrounded(t)`) + 2 general tasks (attach+read → `matchesExpected(reply, 'Alice')`; strict format → `matchesExpected(reply, /\{\s*"answer"\s*:\s*42\s*\}/)`).
- Produces (in `run.ts`): a `runOne(model, task, ctx)` that drives one turn and returns a scored result; a `main()` that loops the roster × tasks and writes the report.

- [ ] **Step 1: Write `roster.ts`**

Define `ROSTER` (the 5 candidates above with exact ids) and `TASKS` (the 5 MCP prompts + 2 general, each with its `expectedTool` and `score`). Use the MCP prompts from the spec; the attach task carries a small inline CSV (`name,score\nAlice,91\nBob,77`) with expected `Alice`; the strict-format task expects the JSON regex. No test (it's data) — but keep it importable.

- [ ] **Step 2: Implement `run.ts`'s per-turn driver + a one-model dry run**

`run.ts` needs, once at start: resolve the scratch group's folder + agentGroupId + a session cookie (provision a scratch member OR reuse the owner group — the harness runs host-side, so it can drive via the CLI/session-DB path or the authenticated HTTP path; pick the HTTP path with a minted token, mirroring the live-verification scripts used in A2/A3). For each `(model, task)`:
1. `updateContainerConfigScalars(agentGroupId, { model: model.model, model_provider: model.modelProvider })`, then recycle the group's container (kill it so the next turn respawns with the new model) — reuse the existing kill/restart helper (`killGroupContainer` / `simple-restart`); wait for readiness.
2. Record `sinceIso = new Date().toISOString()` (pass a timestamp — the script may not call `new Date()` in a workflow context, but a plain `tsx` script can; if run under the workflow engine, accept the timestamp via args).
3. `POST /api/drafts/<folder>/messages { text: task.prompt, files: task.files }`.
4. Poll the session `outbound.db` (via `readTurn(dbPath, sinceIso)`) until a `kind:'chat'` reply appears or a timeout (e.g. 180s); measure wall-clock latency.
5. Score with `task.score(turn)`; record `{ model, task, toolPass, answerPass, latencyMs, errored }`.

Prove the loop end-to-end with a **one-model, two-task dry run** (the current default `qwen3.6-35b-a3b-fp8` on one MCP task + the strict-format task) printed to stdout — confirm it re-points the model, drives the turn, reads the trace, and scores. Do NOT run the full roster yet.

- [ ] **Step 3: Commit**

```bash
git add scripts/model-benchmark/roster.ts scripts/model-benchmark/run.ts
git commit -m "feat(benchmark): roster + task set + per-turn runner (dry-run proven on one model)"
```

---

### Task 3: Full live run + report

**Files:** Modify `scripts/model-benchmark/run.ts` (report rendering); Create `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md` (generated).

- [ ] **Step 1: Add report rendering to `run.ts`**

After the loop, render a markdown report: a **models × tasks** matrix (each cell: `tool✓/✗ ans✓/✗` for MCP tasks, `✓/✗` for general), a per-model summary row (**MCP-reliability** = fraction of MCP tasks with tool✓ AND ans✓; overall pass count; median latency; error count), the raw reply text per (model,task) in an appendix for human spot-check, and a **Recommendation** section (best free-campus default for MCP work; whether the current `qwen3.6-35b-a3b-fp8` default suffices; best fully-private local option; fallback ordering). Write it to `docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md`.

- [ ] **Step 2: Run the full benchmark live**

Rebuild/ensure the host is running. Execute the harness across the full roster × task set (`pnpm exec tsx scripts/model-benchmark/run.ts`), serially. This spawns real container turns per (model,task) — expect tens of minutes. Confirm it completes without harness errors and writes the results file. Tear down the scratch group at the end (token revoked, group + fs deleted, container stopped).

- [ ] **Step 3: Review the results + write the recommendation**

Read the generated report. Confirm the matrix is populated, the MCP-reliability scores are sensible (a strong model should call tools + ground answers; a weak one should visibly fail tool-invoke or grounding), and the recommendation follows from the data. If the current default `qwen3.6-35b-a3b-fp8` is NOT the top free MCP performer, state that clearly and name the better default — but do NOT change any config (owner's call).

- [ ] **Step 4: Commit**

```bash
git add scripts/model-benchmark/run.ts docs/superpowers/reviews/2026-07-12-a1-benchmark-results.md
git commit -m "feat(benchmark): full live run + MCP-reliability report and default recommendation"
```

---

## Self-Review

**1. Spec coverage:**
- Real pi agent turns via scratch group re-pointed per model → Task 2 runner.
- MCP tool-use reliability (tool-invoked from trace + answer-grounded), self-grounded → Task 1 scorers (grounded in a real fixture).
- Task set (5 MCP + 2 general) → `roster.ts` TASKS (Task 2).
- Roster (Clemson 3 + local MLX 2; deepseek/gptoss excluded; DGX deferred) → `ROSTER` (Task 2).
- Latency + error scored → the per-turn result (Task 2) + report (Task 3).
- Report + default recommendation, no auto-change → Task 3 (explicitly no config edit).
- Model routing (clemson/omlx) + model-set-then-recycle → Global Constraints + Task 2 Step 2.

**2. Placeholder scan:** No TBD/TODO. The one genuinely-unknown-until-runtime detail — the exact pi-event tool-name/result field paths — is resolved by the mandated **fixture-capture step (Task 1 Step 1)** before any parser code, with a documented fallback if results aren't in the trace. That is a discovery step, not a placeholder.

**3. Type consistency:** `TurnResult`/`ToolCall` and `readTurn`/`readTurnFromRows`/`toolInvoked`/`answerGrounded`/`matchesExpected` names are defined in Task 1 and consumed unchanged in Task 2; `ROSTER`/`TASKS` shapes defined in Task 2 and consumed by the runner; model ids + `model_provider` values match the Global Constraints roster verbatim; the report file path is consistent between Task 3 steps.
