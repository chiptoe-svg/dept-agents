# Pi Sub-Agents via Platform-Level Routing

> **Status:** Design + scope. Not yet execution-ready (no line-numbered tasks).
> Promote to `docs/superpowers/plans/YYYY-MM-DD-pi-sub-agents.md` when ready to execute.

**Goal:** Give pi-running agents access to sub-agents without forking to Oh My Pi or building in-process spawning. A `spawn_sub_agent` MCP tool wraps NanoClaw's existing `src/modules/agent-to-agent/` routing so the parent agent calls a tool, the platform spawns a sibling container, and the response comes back as a `tool_result`. Each sub-agent runs in its own container with its own trace.

**Architecture:** Platform-level, not in-process. Sub-agents are full NanoClaw sessions in their own containers, observable end-to-end, with independent cost tracking and session JSONL files. The parent agent doesn't know it's running a sub-agent — it just sees an MCP tool call. The MCP tool internally calls `agent-route.ts`'s send-to-group mechanism and awaits a response. Coordination overhead is intentionally visible (latency shows in the trace).

**Tech Stack:** TypeScript on Bun (container side). `@earendil-works/pi-agent-core` for MCP-tool registration via `pi-mcp-bridge.ts`. Existing `src/modules/agent-to-agent/` module for routing. No new external dependencies.

---

## Why this approach over alternatives

| Alternative | Trade |
|---|---|
| **In-process sub-agents (Claude Code Task tool style)** | Pi rejects this on principle. Would require Oh My Pi fork or custom implementation. Fast and context-sharing but invisible to instrumentation. |
| **Oh My Pi (`@oh-my-pi/*` fork)** | Replaces pi ecosystem wholesale. Existing `pi.ts` integration breaks. Adds features beyond sub-agents we don't want (LSP, browser, Python tool baked in). |
| **Bash-spawn pi as subprocess from within pi** | Pi's own recommended escape hatch. Works but no cost tracking, no trace visibility, no clean way to return structured results. |
| **Platform-level via agent-to-agent (this plan)** | Reuses existing NanoClaw infra. Each sub-agent visible with own trace + cost. Coordination overhead is real and teachable. Heavier per call (container startup) but observability is the win. |

## Non-goals (deferred)

- **In-process / shared-context sub-agents.** If a class lesson eventually needs CrewAI-style tight swarms, that's a separate decision and probably a comparison lesson (run external CrewAI alongside NanoClaw and contrast) rather than baking it into NanoClaw.
- **Sub-agent budgets.** No "parent can spawn at most N sub-agents per turn" or "$X cost cap." Add when abuse becomes a real risk.
- **Recursive sub-agents.** A sub-agent spawning its own sub-agent works mechanically but adds depth-limit and cycle-detection concerns. Add depth limit when first needed.
- **UI for authoring sub-agent roles.** Instructors will configure via existing agent-group creation + a role label convention; rich UI is Phase 3+ playground work.

---

## File structure

**New files:**

```
container/agent-runner/src/providers/pi-tools/
├── spawn-sub-agent.ts              # MCP tool definition + execution logic
└── spawn-sub-agent.test.ts         # Unit tests with mocked router
```

**Modified files:**

```
container/agent-runner/src/providers/pi.ts
  Import spawnSubAgentTool factory and append to the tool array
  passed into createAgentSession. ~3 lines.

container/agent-runner/src/providers/pi-mcp-bridge.ts
  No changes expected — spawn_sub_agent is just another pi tool;
  the bridge is for MCP→pi-tool direction (other way). Verify on
  first read.

src/modules/agent-to-agent/agent-route.ts
  Likely no changes if existing resolveTargetSession() takes
  group ID or folder. Possibly add a resolveByRoleLabel() helper.
  Decide during Task 1.
```

**Possible new DB column** (decide during Task 1):
- `agent_groups.role_label` for role-based lookup, OR
- Reuse `agent_groups.folder` as the role key (cheap, no migration)

---

## Prerequisites

1. Pi integration live in the target install. Currently true in `nanoclaw_personal` per [`docs/superpowers/plans/2026-05-23-add-pi-minimal.md`](../../nanoclaw_personal/docs/superpowers/plans/2026-05-23-add-pi-minimal.md); will be true in classroom after the classroom pi port (separate plan, not yet written).
2. `src/modules/agent-to-agent/` module present. Already in trunk.
3. At least two agent groups in the install — one as the parent role, one as the sub-agent role. For development, two test groups suffice.

---

## Tasks (high-level — promote to execution-ready when scheduled)

### Task 1: Discovery — how does agent-to-agent currently resolve targets?

Read `src/modules/agent-to-agent/agent-route.ts` end-to-end. Document:
- What `resolveTargetSession()` accepts as input (group ID? folder? label?)
- How a message goes from "send to group X" → message lands in X's `inbound.db`
- How the *response* comes back to the original sender (return channel? destination wiring? polling?)

Output: a 1-page note in this plan describing the actual mechanics. The rest of the plan depends on this.

### Task 2: Define the `spawn_sub_agent` tool surface

In `container/agent-runner/src/providers/pi-tools/spawn-sub-agent.ts`:

```typescript
// Pseudocode — final signature depends on Task 1 findings
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export function createSpawnSubAgentTool(deps: {
  routeToGroup: (groupRef: string, prompt: string) => Promise<SubAgentResult>;
  defaultTimeoutMs?: number;
}): AgentTool {
  return {
    name: 'spawn_sub_agent',
    description: 'Delegate a task to a sub-agent and wait for its response. ' +
      'Sub-agents run in isolated containers. Use for specialized roles ' +
      '(researcher, critic, planner) when delegation is clearly cheaper than ' +
      'doing the work yourself. Each call has container startup overhead — ' +
      'do not use for trivial sub-tasks.',
    parameters: Type.Object({
      role:       Type.String({ description: 'Sub-agent role label (matches an agent_groups.role_label or folder).' }),
      task:       Type.String({ description: 'The task description to send. Be specific — sub-agent has no parent context unless you include it here.' }),
      timeout_ms: Type.Optional(Type.Number({ description: 'Max wait time in ms (default 60000).', minimum: 1000, maximum: 600000 })),
    }),
    execute: async (params, signal) => {
      // Calls deps.routeToGroup, awaits, returns AgentToolResult
    },
  };
}
```

The dependency-injection shape lets us mock `routeToGroup` cleanly in tests.

### Task 3: Implement the bridge

In `spawn-sub-agent.ts:execute`:
- Resolve role → target group via the mechanism Task 1 identified
- Send the task as a message to that group's inbound.db
- Await the sub-agent's response (via the return mechanism Task 1 identified)
- Honor `timeout_ms` — return an error tool result if exceeded
- Return a structured tool result:
  ```typescript
  {
    content: [{ type: 'text', text: <sub-agent reply> }],
    details: {
      sub_agent_group: <group id>,
      sub_agent_session: <session id>,
      latency_ms: <how long>,
      sub_agent_cost_usd: <if available>,
    }
  }
  ```

### Task 4: Tests

`spawn-sub-agent.test.ts`:
- Mock `routeToGroup` returning a fixed reply → verify tool returns expected structure
- Mock `routeToGroup` rejecting after a delay → verify timeout fires and returns error tool result
- Verify the `details` object includes the metadata downstream consumers expect

Plus one smoke test against two real local agent groups:
- Create a "researcher" agent group with a simple persona
- Have a "primary" agent invoke `spawn_sub_agent({ role: 'researcher', task: '...' })`
- Verify response comes back, both trace rows visible in playground

### Task 5: Wire into pi's tool factory

In `container/agent-runner/src/providers/pi.ts`:
- Import `createSpawnSubAgentTool`
- Wire dependencies — `routeToGroup` calls into `agent-route.ts`
- Add to the array of tools passed to pi's session

### Task 6: Trace verification

Run a real spawn end-to-end and verify:
- Parent trace shows `tool_call: spawn_sub_agent { role, task }` event
- Parent trace shows `tool_result: { content, details }` event
- Sub-agent's own session appears in the playground's session list
- Click-through from parent trace to sub-agent trace works (or document the gap if not yet wired)

---

## Open questions to resolve during execution

1. **Role resolution:** new `role_label` column on `agent_groups`, or reuse `folder` as the lookup key? Lean toward `folder` (no migration). Decide after Task 1.
2. **Return channel:** does `agent-to-agent` already deliver responses back to a calling session, or do we need a return-address mechanism? Task 1 answers this. If not present, scope expands by ~1-2 days.
3. **Async vs sync semantics:** should `spawn_sub_agent` always block until response, or also support fire-and-forget (`await: false`)? Default is sync (matches model expectations of tool calls). Fire-and-forget is a Phase 2 feature if useful.
4. **Cost attribution:** should the parent's cost line include sub-agent costs, or are they reported separately? Lean toward separate — keeps the parent's bill honest and makes sub-agent overhead visible. Confirm with classroom cost tracking.
5. **Approval flow:** does spawning a sub-agent need owner/admin approval (like self-mod tools)? Probably not by default — it's analogous to using any other tool. But may warrant a `requires_approval: true` flag for classroom installs where students shouldn't burn budget unsupervised. Defer to install-time config.

---

## Effort estimate

- **3–5 days** if `agent-to-agent` already supports the return-channel pattern we need.
- **1 week** if we need to add a return helper or a small DB migration.
- Add **1–2 days** for classroom-side wiring once classroom has pi (the tool implementation is install-agnostic; the wiring is per-install).

---

## Sequencing in the broader roadmap

This plan depends on pi being live in the target install. Recommended order across all pi-related plans:

| Order | Plan | Status |
|---|---|---|
| 1 | Personal pi validation install | [Shipped — see `2026-05-23-add-pi-minimal.md`](../../nanoclaw_personal/docs/superpowers/plans/2026-05-23-add-pi-minimal.md) |
| 2 | Personal → pi-only switchover (drop Claude SDK + Codex as active providers, leave dormant) | Not yet planned — separate plan, ~1 week |
| 3 | Classroom pi port (with credential-proxy auth, not OneCLI) | Not yet planned — separate plan, ~2-3 weeks |
| 4 | Trace event vocabulary expansion + per-harness normalizer extraction | Not yet planned — separate plan, ~1.5 weeks |
| 5 | Bench / Harness playground tabs against pi-native events | Existing scope per `agent-playground-v2.md` and Phase 3 of `master.md` |
| 6 | **This plan — sub-agents via agent-to-agent** | Triggered by a class lesson that needs delegation, or by an agent group whose persona benefits from offloading |

Order #6 can slot earlier if a specific personal-install workflow needs it sooner — there's no hard dependency on the classroom path.

---

## What this strategy preserves

- **Pi as the harness for everything.** No fork, no Oh My Pi adoption, no ecosystem switch.
- **NanoClaw's container model as the isolation primitive.** Already battle-tested. Each sub-agent gets the same isolation guarantees as any other session.
- **Observability as a first-class teaching surface.** Every sub-agent run is a real session with a trace, cost, and JSONL artifact students can replay.
- **Single ecosystem for all pi-related work.** `@earendil-works/*` packages, one upgrade path.

## What this strategy gives up

- **In-process speed.** Container startup adds ~1-2 seconds per sub-agent call vs. ~milliseconds for in-process. Acceptable for delegated work; not acceptable for fine-grained parallelism.
- **Implicit context sharing.** Sub-agent doesn't see the parent's transcript automatically. Caller must include needed context in `task`. This is also a teaching point (students see what context the sub-agent actually got).
- **Sub-second swarms.** Don't try this with 20 micro-agents per turn. If that pattern matters, it's a different platform (and a different teaching unit).

---

## When to revisit this design

Trigger revisit if any of:
- A class lesson genuinely needs sub-second sub-agent fan-out (re-evaluate in-process options)
- Sub-agent traces become too noisy in the playground for the parent's flow
- Cost attribution proves more complicated than per-session billing
- Container startup overhead becomes a real bottleneck for typical use (could shift to warm pool, but only if data demands it)
