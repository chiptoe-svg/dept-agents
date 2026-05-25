# Classroom Cost Guardrails (Runaway Meter)

> **Status:** Design + scope. Not yet execution-ready (no line-numbered tasks).
> Promote to `docs/superpowers/plans/YYYY-MM-DD-classroom-cost-guardrails.md` when ready to execute.

**Goal:** Detect and stop runaway agent costs before they impact the class. Five distinct failure modes need different signals. MVP covers ~85% of incidents with three pieces; full coverage is a sequence.

**Architecture:** Built on per-turn usage data that all providers (pi, Claude SDK, Codex) already emit into `outbound.db.session_state`. Detection lives in the agent container (per-session) and the playground (per-class). No new credential infrastructure required.

**Tech Stack:** Existing — `outbound.db` (Bun-sqlite), provider event subscribers, playground SSE, `ncl` CLI for ops.

---

## OneCLI dependency — answered upfront

**The runaway meter does NOT require OneCLI.** Per-level:

| Level | Data source | OneCLI needed? |
|---|---|---|
| 1 — Live dashboard | `outbound.db.session_state.usage` | **No** — read-only query on existing data |
| 2 — Per-session cap | Cumulative usage check after each turn | **No** — check happens in poll-loop / container; all providers emit cost |
| 3 — Per-student daily cap | Aggregate across user's sessions | **No** — DB aggregation only |
| 4 — ChatGPT-subscription cap | Count calls + estimated tokens from provider's emitted events | **No** — pi sees the calls even when OneCLI bypasses them. Precision tradeoff: detection is post-call, not pre-call |
| 5 — Pattern detection (tool-loop, no-progress) | Tool-call args from event stream | **No** — pure container-side logic |

**What OneCLI WOULD add:** pre-call interception (refuse the call before it's sent vs detect after the response comes back). For cost-runaway scenarios this is "halt mid-conversation" granularity vs "halt at end of turn." Most failure modes don't need that — one extra turn after the cap hits doesn't change outcomes much, and pi correctly halts the session before the next prompt is sent.

**Where OneCLI absence actually matters:** Level 4 only, and only by a few seconds. Counting ChatGPT-subscription calls from pi's emitted events means you're one turn behind reality. Acceptable for cap-detection. If you ever want true pre-call interception for ChatGPT, that's the OneCLI Option A fix discussed in [`pi-migration-gotchas.md`](pi-migration-gotchas.md) — independent of this plan and not on its critical path.

**Net:** This plan stands alone. The OneCLI ChatGPT-bypass is a separate concern that can be fixed if and when desired; the runaway meter works fine without it.

---

## The five failure modes

| Mode | Signature | Why it matters in class |
|---|---|---|
| **Tool-use loop** | Same tool + similar args, called repeatedly without progress | Burns tokens fast, no completion — cheap per call but cumulative |
| **Per-turn cost spike** | Single turn pulls in huge context, one turn costs $X+ | One bad turn can eat a per-session budget |
| **High-frequency turns** | Many turns per minute, even if each is cheap | Drains rate limits + aggregates fast across the class |
| **Long tool execution** | Bash command hangs / fetch never returns | Burns wall-clock; may keep thinking tokens flowing |
| **Subscription cap approach** | Aggregate hits ChatGPT's per-account daily ceiling | **Cuts off *all* students** sharing the subscription |

The last one is the worst for shared-subscription classroom use. The other four hit one student / one session.

---

## The five levels of defense

### Level 1 — Reactive instructor dashboard (lowest effort)

Live panel in playground Home tab. Shows: active sessions, per-session cost-so-far, time running, last activity timestamp, current model. Instructor can click for detail, can manually kill.

- Effort: 1-2 days. Reads existing data; mostly UI work.
- **Doesn't prevent runaway, makes it visible.**
- Pairs naturally with Bench tab work (same UI patterns).

### Level 2 — Per-session cost cap with auto-halt

Each session has a max cost budget (default $X, per-agent-group override via container_configs). Container checks cumulative cost after each turn. If `cumulative > budget`, halt with a user-visible message and write `session_state.halted_reason = 'budget_exceeded'`.

- Effort: 1-2 days. Cost data per turn already captured.
- **Prevents single-session disasters.**
- Personal pilots this first — see Sequencing.

### Level 3 — Per-student daily cap aggregated across sessions

Sum across all sessions for a `user_id` today. Router blocks new turns (and new sessions) when cap reached. Reset at midnight class-timezone.

- Effort: 3-4 days. Needs aggregation query + router gate + scheduled reset.
- **Prevents one student from impacting class.**
- Requires Level 2 in place first (uses the same per-session totals).

### Level 4 — ChatGPT-subscription rate/call meter

Different metric: not dollars, but calls/hour and estimated tokens per account, compared against known ChatGPT subscription caps. Predicted cap-hit time given current pace. Warn instructor before the hard wall hits.

- Effort: 2-3 days. Count from pi's emitted events; ChatGPT cap thresholds are known (or empirically tunable).
- **Prevents shared-subscription wipeout.**
- Account-keyed, not session-keyed — multiple students sharing an account aggregate together.

### Level 5 — Pattern detection (tool-loop, no-progress)

Heuristic: same tool name + similar args called > N times in a row = halt. Heuristic: many turns with high thinking/tool output but low text output = stuck. Configurable thresholds.

- Effort: 3-4 days, mostly tuning thresholds against real incidents.
- **Catches cheap-but-loopy failures that pure cost caps miss.**
- Lower priority — incident-driven, not preventive.

---

## MVP

Three pieces that together cover ~85% of class-day failure modes:

1. **Per-session cost cap with auto-halt** (Level 2) — invisible until it fires
2. **Live instructor dashboard** (Level 1) — what's burning right now, with kill button
3. **ChatGPT-subscription rate/call meter** (Level 4 lite) — count from pi events, alert before hard cap

**Total effort: ~1 week.** Levels 3 and 5 added later if specific class-time incidents demand them.

---

## Sequencing

1. **Personal pilot (Week 0):** Per-session cost cap (Level 2) in personal. 1-2 days. Validates the algorithm. Personal benefits from "halt at $X" too even though personal doesn't have classroom-scale runaway risk.
2. **Classroom MVP (Weeks 1-2):** Port Level 2 to classroom. Add Level 1 dashboard. Add Level 4 ChatGPT meter. ~1 week.
3. **Iterate (Weeks 3+):** Add Levels 3 and 5 based on observed incidents.

---

## File structure (placeholder — settle during execution)

**Likely:**

```
container/agent-runner/src/cost-guardrails/
├── cap-check.ts              # Pure function: cumulative cost + budget → halt decision
├── halt-on-cap.ts            # Container-side enforcement; subscribes to provider events
└── cap-check.test.ts

src/modules/cost-guardrails/
├── per-student-aggregate.ts  # Level 3 — DB aggregation
├── chatgpt-cap-tracker.ts    # Level 4 — call counting + cap projection
└── ... tests

src/channels/playground/public/tabs/home.js
- Add "Live runs" panel section (Level 1 surface)

src/db/migrations/<new>-session-budgets.ts
- Add `budget_usd` column to agent_groups (or container_configs)
- Add `halted_reason` column to session_state if not present

src/cli/resources/
- Extend groups verb with budget set/get
- Possibly add a `guardrails` resource for class-level dashboard data
```

Specifics settle when promoting to execution-ready plan.

---

## What this does NOT cover

- **OneCLI ChatGPT bypass / audit gap** — separate concern. Meter sees the calls via provider events; doesn't audit them through OneCLI. See [`pi-migration-gotchas.md`](pi-migration-gotchas.md) Option A discussion.
- **Real-time pre-call interception** — post-call halt is fine for cost runaway. Don't build this without a concrete need.
- **Multi-agent / sub-agent budgets** — when sub-agents ship per [`pi-sub-agents.md`](pi-sub-agents.md), cost caps need to account for sub-agent spawns. Defer the integration until sub-agents are real.
- **Time-of-day rate limits** ("no agent runs after 11pm") — different feature, not in scope.
- **Hard per-class daily ceiling** — possibly add as Level 6 if instructor budget pressure becomes specific.

---

## Cross-references

- [`pi-sub-agents.md`](pi-sub-agents.md) — sub-agent cost accounting will need to integrate here when shipped
- [`pi-migration-gotchas.md`](pi-migration-gotchas.md) — OneCLI ChatGPT-bypass context; relates to Level 4 precision
- `plans/master.md` — slot into the classroom roadmap (Phase 3 or its own track; instructor cost dashboard pairs naturally with Bench tab work)
- `plans/credential-proxy-per-call-attribution.md` — shipped per-call attribution feeds the per-student aggregate work in Level 3

---

## Open questions to resolve during execution

1. **Default per-session budget:** $0.50? $1.00? Want a small enough number to catch real runaways, big enough not to halt normal long conversations. Probably needs class-day calibration data.
2. **Halt mechanism for the in-flight provider:** abort the active query and write a clear final message, or let the current turn finish then refuse the next? Lean toward "finish current turn, refuse next" — cleaner from the model's perspective.
3. **Recovery UX:** how does a student resume a halted session? Reset to a new session, or instructor-approved budget bump on the existing one? Decide before Level 2 ships.
4. **ChatGPT cap thresholds:** values aren't published. Calibrate empirically by observing real cap-hits, or pre-set conservative defaults?
5. **Per-agent-group override placement:** new column on `agent_groups`, or live in `container_configs` JSON? Lean toward `container_configs` to avoid a schema migration.
