# Pi Migration Gotchas

> Running notes on issues observed in the existing Claude SDK / Codex / pi setup that bear on the pi switchover. Each entry is a real production observation, not a hypothetical. Date-stamped so the timeline is honest.

---

## 2026-05-25 — Claude SDK bakes system prompt at session-init; resume restores the old prompt

**Symptom:** Updated a directive in `groups/dm-with-chip/CLAUDE.md` (routing-prefix). The change was visible in fresh-prompt diagnostics for pi-based agents (Pi-CO grep returned 1 — directive present in active prompt). Linda's static prompt dump still showed the old 18 lines — directive absent.

**Root cause:** Linda's `session_state` had a saved Claude Agent SDK continuation (`claude|fd0406a9-…`). The SDK's `resume:` parameter restores the session from when it was originally started — **the system prompt is baked in at session-init time, NOT re-applied per turn.** So Linda was running with the previous system prompt. Persona / CLAUDE.md edits made after that init don't propagate into the resumed session.

**Fix applied:** Cleared Linda's stored continuation in `session_state`. Next turn she gets a fresh SDK session that picks up the current system prompt. Cost: lost recent conversation history.

**Why pi-based agents didn't show this:**
- Pi-CO had the directive in its active prompt (grep 1)
- Pi's `Agent.state.systemPrompt` is mutable per turn — there's no init-time baking
- Pi reads from the JSONL session file but rebuilds the system prompt from the current `AgentState`, not from the baked transcript header
- Net: edits to CLAUDE.md fragments take effect on Pi agents at the next turn without requiring a session reset

**Other Claude SDK agents in personal that may have the same latent issue:** any agent group whose `session_state.continuation` was set before the last persona / fragment edit. Specifically watch: any non-pi agent that was active before the recent CLAUDE.md change. Doesn't manifest as a visible bug unless the edit's content would change observable behavior (Linda's slash-command disclaimer was the giveaway here).

**Codex notes:** Codex App Server's continuation may have the same characteristic — needs verification. Pi-based agents are the safe path.

---

## Implications for the pi-only switchover plans (#2 personal, #3 classroom)

**Promotion:** When swapping an existing Claude-SDK-backed agent group to pi:
- The stored continuation is provider-incompatible (`claude|<id>` won't load into pi)
- Just **clear `session_state.continuation`** for the group before flipping `container_configs.provider` from `claude` → `pi`
- Accept that current conversation context is lost — same cost as Linda's reset above
- Document this in the switchover runbook as expected, not an error

**Demotion (rollback):** Going pi → claude has the same dynamic, in reverse. Pi continuations don't load into Claude SDK. Clear and accept context loss.

**Persona / CLAUDE.md edits during the switchover window:** pi handles these per-turn. Claude SDK requires a continuation clear. This means during a phased migration where some groups are pi and some are still Claude SDK, **a global CLAUDE.md edit has heterogeneous propagation semantics**: pi groups pick it up immediately, Claude SDK groups need their continuations cleared. Operators should know this.

**Per-group continuation clearing as a routine maintenance step:** even before the switchover, it may be worth adding a `ncl groups reset <id>` command (or equivalent SQL) so operators don't have to hand-edit `session_state`. Scope: ~10 LoC + cli/resources entry.

---

## Implications for the trace vocabulary expansion plan (#4 in roadmap)

The system prompt is per-turn data even though Claude SDK pretends otherwise. The proposed `harness_context` event should emit:
- System prompt **as currently effective for this turn** (which for Claude SDK means the one baked at the resumed session's init time, NOT the live CLAUDE.md fragments)
- Tool definitions as the harness sent them
- Active model + thinking level

This gives instructors a way to **see** when a Claude SDK agent is running with stale prompt content — the trace will show one thing, the CLAUDE.md file another. That's actually a teaching moment: "look how the SDK's resume contract creates a divergence between what the file says and what the model sees."

Pi's `harness_context` will always match the live CLAUDE.md fragments because pi reads them per turn. The contrast itself is pedagogically valuable.

---

## How to add new gotcha entries

Append to this file under a new date-stamped section. Use the format:
- **Symptom** — observable behavior
- **Root cause** — what's actually happening
- **Fix applied** — what you did, with cost
- **Why other systems didn't show this** (if relevant)
- **Implications for the switchover plans**

Keep entries terse but specific. Future-you needs the symptom string to recognize the issue when it surfaces again.
