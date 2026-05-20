# Agent-harness benchmark suite

**Goal.** A repeatable benchmark we can run against any combination of
agent harness + model + configuration, producing comparable
cost / latency / quality metrics. Used to (a) understand the
codex-vs-claude cost gap we hit on 2026-05-18, (b) inform harness
optimization work, and (c) make model-choice recommendations to
instructors with real data behind them.

**Status.** Planned. Triggered by the 364k-input-token "yolo" turn on
codex/gpt-5.4 (Phase 1.7 day) that exposed the structural cost gap
versus claude's single-call-per-turn pattern.

**Distinct from Phase 2 #9 (classroom evaluation framework).** That
work is the student/instructor-facing side-by-side comparison UI that
sits on top of RAG strategies (Phase 2 #8). This suite is the
*developer* benchmark — internal tooling, not user-facing — and
should land first because the eval-framework's design will benefit
from us having concrete cross-harness data already.

## The 5 requests

Each task is intentionally specific (verifiable outputs) and chosen
to isolate a different cost-amplification factor.

| # | Request | What it isolates |
|---|---|---|
| **1. Pong** | "Reply with exactly the word `Pong` and nothing else." | Pure harness fixed cost. No tools. No continuation. Floor — measures what the harness/system-prompt/tool-defs alone cost. |
| **2. UTC clock** | "What is the current UTC time? Use a tool to find out." | Single trivial tool call, ~10-byte payload. Measures one-tool overhead. |
| **3. Title fetch** | "Fetch https://example.com and tell me the page's `<title>`." | One tool call returning a real-world payload (~1 KB). Tool-output amplification within a single turn. |
| **4. Three-turn lesson** | a) "I'm planning a 30-minute Python lesson on dictionaries. Outline what I should cover." → b) "Add a runnable code example for each topic." → c) "Rewrite the examples in JavaScript." | Same thread, three turns. Continuation amplification — codex's known worst case. |
| **5. Comparative research** | "Fetch these three URLs, summarize each in 50 words, then pick the most beginner-friendly and explain why." Three short articles, ~2–5 KB each. | Multi-tool chain with non-trivial payloads + synthesis. Closest to realistic instructor workload. |

URLs for requests 3 and 5 must be pinned to versioned snapshots (e.g.
the suite ships fixture HTML in a tiny static server) so the
benchmark is reproducible. Live URLs would inject content drift into
the measurement.

## What we capture

The existing trace stream already carries everything we need — no new
agent-runner instrumentation:

- `model_call` events: per-LLM-response input / cached / output /
  reasoning tokens, latency.
- `tool_use` / `tool_result` events: tool name, input + output size.
- `agent_call` event: turn cumulative (codex emits this as
  `tokenUsage.total`; claude emits it as the final `result.tokens`).
- `result` event: final assistant text + total turn latency.

Persist to a new SQLite at `data/benchmarks.db`:

```sql
CREATE TABLE runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL,
  system_under_test TEXT NOT NULL,   -- provider/model/config short name
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  harness_config    TEXT,            -- JSON: skills, personality, etc.
  request_id        TEXT NOT NULL,   -- 'pong' | 'utc-clock' | …
  repetition        INTEGER NOT NULL,
  success           INTEGER NOT NULL,
  output_text       TEXT,
  total_input_tokens     INTEGER,
  total_cached_tokens    INTEGER,
  total_output_tokens    INTEGER,
  total_reasoning_tokens INTEGER,
  num_api_calls          INTEGER,
  num_tool_calls         INTEGER,
  latency_ms             INTEGER,
  cost_usd               REAL,
  quality_score          REAL,        -- LLM-judge 0..5 (null if skipped)
  programmatic_pass      INTEGER,     -- 1 if task-specific gate passed
  notes                  TEXT
);

CREATE TABLE events (
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  event_json TEXT NOT NULL,           -- raw ProviderEvent for forensics
  PRIMARY KEY (run_id, seq)
);
```

Raw events kept so we can re-derive metrics if we change definitions
(e.g. switch from "billed input minus cached" to "billed + cached"
without re-running the suite).

## Assessment: three layers

1. **Token / cost / latency** — auto-captured from trace events.
   Hard numbers. No interpretation.
2. **Programmatic correctness** — per-request gates. Cheap,
   deterministic:
   - Req 1: `output.trim() === "Pong"`
   - Req 2: extract `HH:MM(:SS)?` UTC, within ±5 min of wall-clock
   - Req 3: output contains `Example Domain` (the actual title)
   - Req 4: each of 3 turns produces ≥3 bullet points
   - Req 5: output mentions all three article titles and explicitly
     picks one
3. **Quality rubric** — claude-haiku-as-judge scoring 0–5 on
   (a) relevance to ask, (b) concision, (c) formatting. Single prompt
   that takes (request, output) and returns a JSON `{score, rationale}`.
   Spot-check the spot-checker against human review for the first
   ~10 runs to confirm haiku's judgments are sane.

## Test matrix (axis = system under test)

V1 target list, sorted by what teaches us the most:

- `claude / claude-sonnet-4-6` — **baseline** (user-specified)
- `claude / claude-haiku-4-5` — cheap-Anthropic floor
- `codex / gpt-5.4-mini` — closest codex equivalent on price
- `codex / gpt-5.4` — what's currently running on InstructorBot
- `local / gemma-4-31B-it-MLX-4bit` — free-tier reference
- `local / Qwen3.6-35B-A3B-UD-MLX-4bit` — local with reasoning

Three repetitions per cell → ~90 runs for the full matrix. At
catalog prices that's well under $5 of API spend for the cloud half;
local runs are free.

## Implementation: where it lives

A standalone `scripts/bench.ts` that drives the playground HTTP API —
real codepath, real proxy, real container, real numbers. **Not** a
vitest suite (we want production behavior, not mocked providers).

```
scripts/bench.ts <system-name>    # one system, all 5 requests, N reps
scripts/bench.ts --matrix         # full matrix
scripts/bench-report.ts           # render data/benchmarks.db as markdown table
```

The bench runner:
1. Provisions a clean agent group per system-under-test (so harness
   config doesn't leak between cells).
2. For requests 1, 2, 3, 5: clears the continuation in `session_state`
   before each rep so the thread starts fresh.
3. For request 4: starts fresh, runs all 3 turns on the same
   continuation, persists each turn as a separate `runs` row (with
   `request_id='lesson-1'`, `'lesson-2'`, `'lesson-3'`).
4. Streams SSE trace events, writes raw events + aggregated metrics
   to `data/benchmarks.db`.
5. After all runs in a cell, dispatches the LLM-judge call for each.

Fixture server for requests 3 and 5: a tiny static HTTP server on
localhost serving three pre-saved HTML files. Avoids live-web drift.
Bench script starts/stops it.

## Phasing

| Phase | Scope | Estimate |
|---|---|---|
| **B0 (prereq, must land first).** | Fix token-accounting on both providers so benchmark cost numbers are comparable. Three sub-fixes: (a) `container/agent-runner/src/providers/claude.ts:374` — widen the `usage` type cast to include `cache_creation_input_tokens` and `cache_read_input_tokens`; (b) extend the `ProviderEvent.tokens` shape with `cacheCreation` and `cacheRead` fields and forward both providers' values through the `result` event (codex already captures `tot.cachedInputTokens` locally — just plumb it); (c) update `computeAgentCallCost` in `chat.js` to apply Anthropic's cache-write (1.25×) and cache-read (0.1×) rates from the catalog, retire the chat.js sibling-walk-for-cached hack from today's `finalizeTurn` fix. **Gate:** rerun the same 5-message claude thread and same codex thread; verify cost moves to within ±2% of provider-reported billing. | 1.5 hr |
| **B1.** | `bench.ts` skeleton, `benchmarks.db` schema, the 5 requests as data, single-system runner against `claude / claude-sonnet-4-6` only, trace capture + DB writes. Produces a single-system report. **Gate:** numbers match what we see in the live playground for the same requests. | 2 hr |
| **B2.** | Programmatic-gate functions per request, claude-haiku-judge integration for quality rubric. Spot-check first 10 outputs by hand. | 1 hr |
| **B3.** | Multi-system matrix runner (system-under-test as config), report renderer (markdown table: system × metric × request). | 1 hr |
| **B4.** | Run the full matrix against codex variants + local variants. Capture forensic events. **First real diagnostic dataset for the codex cost-gap.** | 1 hr setup + run-time |
| **B5.** | Context-window observability — `src/credential-proxy.ts` gains a debug flag (`PROXY_LOG_PAYLOADS=1`) that logs per-request upstream-body size and, when full-dump is enabled, the redacted payload itself to `logs/proxy-payloads.jsonl`. Partitioned by route (anthropic / openai / omlx). One row per upstream API call so we can see exactly what each harness sent. Used to answer: "claude turn 7 of a long thread — what bytes went up the wire? Were the cache breakpoints honored?" Off by default; bench script flips it on for the runs we want to forensically dissect. | 1 hr |
| **B6 (optional, deferred).** | Add harness-config dimensions (with/without skills, with/without reasoning, with/without continuation pruning) so we can isolate which knobs matter most for the gap. | 2 hr |

Total to land B0–B5 (the useful + observable data point): **~7.5 hr** of focused work.

## Open decisions (resolve before starting)

1. **Are the 5 tasks the right shape?** Slot 5 currently exercises
   multi-fetch + synthesis. Alternative: wiki / persistence task that
   exercises memory across turns (probes a different harness aspect:
   how big does prior context grow). Lean: keep as-is; the
   multi-fetch case is closer to what blew up codex on 2026-05-18.
2. **Three reps per cell or more?** Three captures variance cheaply;
   five gives tighter confidence intervals. Lean: three for B1–B4,
   bump if numbers look noisy.
3. **LLM-judge model.** `claude-haiku-4-5` (cheap, biased toward
   Anthropic outputs) vs `claude-sonnet-4-6` (more accurate, ~12×
   cost). Lean: haiku, with hand-spot-checks on first ~10 to
   calibrate. Switch to sonnet if haiku's judgments diverge from
   human gut consistently.
4. **Test matrix v1 scope.** All 6 systems from the start, or just
   the two baselines (claude-sonnet + codex/gpt-5.4) and expand later?
   Lean: start narrow, get B1 + B2 working clean, then widen in B3.

## Success criteria

The suite is "done enough to act on" when:

- All 6 V1 systems run all 5 requests end-to-end without manual
  intervention.
- The report renders a side-by-side table that makes the codex /
  claude cost gap quantitative (not just qualitative).
- We can re-run the suite with a single command and trust the
  numbers haven't drifted from agent-runner code changes
  (regression-detection use).
- Programmatic gates pass for ≥90% of claude/codex runs at the
  baseline configurations (local-model failure rate is its own
  question, not a suite-validity question).

## Out of scope (for now)

- **Agent harness changes themselves.** This plan builds the
  measurement tool. Acting on what it reveals — context-pruning,
  tool-output truncation, fewer internal codex calls, etc. — is a
  follow-up that the data should justify.
- **CI integration.** Useful eventually but the suite costs real API
  dollars; only run on demand for now.
- **Comparison against non-codex / non-claude harnesses** (langchain,
  llamaindex agents, etc.). Same instrumentation could compare them
  but we don't deploy them — out of scope.
- **Student-facing eval UI.** That's Phase 2 #9.

## Why claude looks so much smaller — what to confirm with B5

Working hypothesis going in (to test with the observability tooling):

- **Claude Agent SDK keeps the full conversation** between calls. It's
  not throwing history away. The session UUID we store as
  `continuation:claude` resumes the same on-disk transcript at
  `~/.claude/projects/<…>/` and the SDK loads it.
- **It marks aggressive cache breakpoints** — `cache_control` on the
  system prompt + on tool definitions + on the first user turn so the
  large prefix is served from Anthropic's 5-min cache at 0.1× rate
  after the first call. The 5-min TTL plays well with the
  single-call-per-turn pattern: a follow-up within the cache window
  pays ~10% of the prefix.
- **One Anthropic API call per user turn** — even when tool use
  happens, the SDK streams a single `query()` whose internal
  message-pump round-trips tool_use/tool_result blocks within one
  conversation that the model continues to elaborate. That single
  call gets cached well.
- **Auto-compaction is reactive, not proactive.** Claude lets the
  conversation grow until it nears the context window and only then
  emits a `compact_boundary` event (which our claude.ts already
  forwards as `compacted`). So the small per-turn cost isn't from
  pruning — it's from caching most of the prefix and only billing
  the new turn at full rate.

Codex by contrast:
- Maintains its own session transcript in `~/.codex/sessions/`
- Makes 6–10 internal OpenAI calls per user turn (plan, decide-tool,
  reflect, etc.)
- Each call's payload mutates (plan state, scratchpad) so OpenAI's
  automatic prefix caching invalidates between sub-calls
- Tool definitions are bigger (codex's own `apply_patch` / `shell` /
  `update_plan` schemas plus our MCP tools) and reset prefix more
  often

B5 (the proxy payload logger) is how we confirm vs. falsify this. If
claude's wire payloads on a long thread are mostly being marked
`cache_control` and most input shows up as `cache_read_input_tokens`,
hypothesis holds. If codex's wire payloads on the same thread are
each near-100% fresh prefix, the caching-mismatch hypothesis holds.
The bench plan should not commit to specific optimizations until B5
has produced wire-level evidence.

## Findings from the pre-bench exploration (2026-05-18)

Before the suite was even built, the act of diagnosing the
"$1.10 yolo" surfaced three things that re-shape what the
benchmark is actually measuring:

1. **The "$1.10 yolo" was a trace-UI artifact, not a per-turn cost.**
   Codex's `tokenUsage.total` is cumulative since the *thread* started,
   not the current turn. Our `agent_call` event surfaced it as
   "agent call: 364653 in" which looked like a single turn's bill but
   was actually 30+ prior turns aggregated. The trace footer
   compounded the misread by labeling it "turn total." Fixed in
   `3471608` (turn total now sums model_call deltas; thread cumulative
   shown as a separate footer line).

2. **Codex on 0.131 with `effort: low` makes ~1 OpenAI API call per
   simple turn, not 6–10.** The "multiple internal calls per turn"
   narrative was wrong. Per-turn cost on a fresh thread: ~$0.005 once
   the cache warms up (turn 2+). The cost we *were* seeing was
   accumulated history × growing thread → cumulative `total` that
   inflated alarmingly but represented many turns' worth of spend, not
   one. This means Path A (custom OpenAI loop) and Path B
   (`@openai/agents-js`) are not needed for cost reasons. **Path C
   (codex flag tuning) is the right place**, and most of the win is
   already booked from `effort: low` alone.

3. **Anthropic's three-tier input pricing was zero-counted in our UI.**
   `cache_creation_input_tokens` (1.25× full input) and
   `cache_read_input_tokens` (0.10× full input) were dropped at the
   provider-SDK boundary. For a long classroom thread with ~80% cache
   read fraction, the claude cost was being under-stated by ~25%.
   Fixed in `397abf8` (cache tokens captured in the claude provider,
   plumbed through `ProviderEvent.tokens` → `content` JSON →
   `ChannelDeliveryMeta` → playground trace; `computeAgentCallCost`
   now applies Anthropic's 1.25× / 0.10× and OpenAI's 0.50× rates
   based on which cache field is populated).

**Implication for B1–B5:** the bench plan still stands, but the
gating question we wanted it to answer ("is codex structurally
expensive, do we need Path A/B?") is answered without it: codex is
fine, the UI was misleading us. The bench's value now is
*comparative* (which model for which task) and *regression detection*
(future codex version doesn't suddenly bloat), not architectural
decision support.

## Discovered codex knobs (post-0.131 upgrade)

Surfaced from <https://developers.openai.com/codex/app-server>
while researching Path C. None of these were on our radar before
2026-05-18; document so the bench can A/B them in B6+.

- **`effort` on `turn/start`** (`low`/`medium`/`high`). Now wired,
  defaulting to `low`. Cuts reasoning output tokens dramatically.
  Per-group override via `container.json.codexEffort`.
- **`summary` on `turn/start`** — controls conversation-history
  summarization strategy. Accepted values not yet characterized;
  worth digging in codex source for the enum.
- **`thread/compact/start`** JSON-RPC method — manual compaction
  trigger. Could fire from the host after `tokenUsage.total` crosses
  a threshold to bound thread growth. (C3 task — deferred.)
- **`thread/rollback`** — drop the last N turns from in-memory
  context. Direct attack on "tool outputs live in context forever."
- **`thread/inject_items`** — append raw Responses API items to
  thread history without starting a user turn. Hypothetical lever
  for pre-stamping curated context that codex won't re-summarize.
- **`dynamicTools` on `turn/start`** (experimental) — pass MCP tool
  definitions per turn rather than thread-wide. We'd only use it
  when the tool set actually changes per turn; using it carelessly
  *breaks* cache stability across turns. (C2 task — deferred.)
- **`excludeTurns` on `thread/resume`** (experimental, added 0.125)
  — selectively drop big-tool-output turns when resuming a thread.
  Direct knob for the "web-scrape lives forever" problem.
- **`service_tier`** in 0.131 session protocol — `default` / `flex`
  / `priority`. Affects latency and possibly caching. On apikey mode
  codex deliberately strips service_tier on compact requests
  (0.130 #21676); preserving it requires ChatGPT subscription auth.

The C2 and C3 tasks were on the cost-crisis path. With the
crisis resolved, they become bench experiments rather than urgent
fixes — useful for finding additional headroom but not load-bearing.

## Why this matters now

The 2026-05-18 cost spike (one "yolo" message billed at $1.10
through codex/gpt-5.4) is a signal we don't actually understand the
cost surface we're shipping to instructors. With ~12 students × N
turns/day × this kind of amplification, a single classroom can run a
multi-hundred-dollar weekly bill we'd have no early warning for. The
benchmark gives us calibrated expectations *before* enrolling the
next class.
