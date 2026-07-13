# A1 — Agent-Task Model Benchmark (MCP tool-use) — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-07-12.

## Where this sits (program context)

Final piece of the department member-experience program. **A2 (onboarding) and A3 (file-capable chat) shipped; this is A1 — the model foundation.** It validates, on evidence, the free-tier default model (currently `qwen3.6-35b-a3b-fp8`) and the fallbacks, so the "free Clemson default" is an evidence-based choice rather than a reasonable guess.

## Goal

For each candidate **free** model, measure whether it reliably drives the department's **MCP tools** (course catalog, class/room scheduling, curriculum, procurement) via **real pi agent turns** — actually invoking the tool and returning a tool-grounded, correct answer — and produce a comparison report + a recommended default + fallback ordering.

## Reframed focus (the headline metric)

Members' real workload is **local MCP tool use** — catalog lookups, room schedules, class times, curriculum, procurement policy — and every one of those skills explicitly instructs the agent *"use these tools, not your own knowledge."* The failure mode that matters: a weak model **confidently hallucinates** a plausible-but-wrong catalog/schedule answer **without calling the tool**. So A1's headline metric is **MCP tool-use reliability**: did the model (a) actually invoke the right MCP tool, and (b) return the correct, tool-grounded answer. This is the capability that decides whether a free model is viable for members.

## Mechanism (real pi agent turns)

A scriptable harness (run once now, re-runnable), driving the real pipeline — NOT raw completion calls:
- For each candidate model M: point a **scratch agent group**'s `container_config` at M (`model` + `model_provider`). Provisioned groups already get the curated MCP set seeded, so the catalog/scheduling/curriculum/procurement tools are present.
- For each task: `POST /messages` → real container turn (tools + credential proxy) → capture the outbound **reply** and the outbound **trace rows** (which record the tool calls the agent made) + wall-clock **latency** + whether the turn errored.
- Score, tear down the scratch group at the end.

Runs **serially** (real containers); ~5 models × ~8 tasks is a bounded run (tens of minutes).

## Task set

**MCP-centric (the headline):** each pass check is two-part — *tool invoked* (from the trace) AND *answer correct* (matches ground truth).
1. **Class search** (`search-clemson-classes`) — "What sections of GC 1010 are offered in Fall 2026?"
2. **Section details** (`get-clemson-section-details`) — "Where and when does GC 1010 section 001 meet in Fall 2026?"
3. **Room availability** (`get-clemson-room-availability`) — "Is Jordan Hall G33 free on a given day/time?"
4. **Curriculum / prereq** (`gc-wiki` / `prereq_chain`) — "What are the prerequisites for <course>?" or a specific content fact.
5. **Procurement policy** (procurement tools) — "What's the P-card single-purchase limit?" or a specific policy value.

**General (round out non-MCP capability), secondary:**
6. **Attach + read** — attach a small CSV, "which name has the max score? reply with just the name" → reply contains the correct name.
7. **Strict format** — "reply with exactly `{"answer": 42}` and nothing else" → parses as that exact JSON.

**Ground truth is self-computed at run time** — before scoring, the harness calls each MCP tool directly (or reads its raw output) to establish the correct answer for that question, so scoring is **robust to live catalog/schedule data changing** between runs. The general tasks (6–7) have fixed expected outputs.

## Scoring

Per model, per task:
- **tool-invoked?** — boolean, from the outbound trace (the right MCP tool was actually called). Catches hallucination.
- **answer-correct?** — the reply contains/matches the self-computed ground truth (MCP tasks) or the fixed expected output (general tasks).
- **latency** — wall-clock to the final reply.
- **turn-error?** — did the turn fail/timeout.

Aggregate per model: an **MCP-reliability score** (fraction of MCP tasks passed with tool-called + correct), an overall pass count, median latency, and error rate. **Cost is not scored** (all candidates are free); each model is tagged by tier (free-campus / free-local).

## Roster (free models; DGX deferred)

- **Clemson** (campus, institution-paid): `qwen3.6-35b-a3b-fp8` (current default — the baseline to beat), `qwen3-30b-a3b-instruct-fp8` (agent-tuned, lower latency), `glm-5.1-fp8` (agentic, different family).
- **Local MLX** (`:8000`, on-box, free + fully private): `Qwen3.6-35B-A3B`, `gemma-4-26B`.

Excluded for latency (a default must be interactive): `deepseek-v4-pro`, `gptoss-120b`. DGX Spark deferred (needs a `/dgx` credential-proxy route; serves the same `gemma-4-26b` class as local MLX — a hardware-speed follow-up).

## Deliverable

A markdown report: a **models × tasks** matrix (tool-called ✓ + correct ✓ per cell), the **MCP-reliability score** + latency + error rate per model, and a **recommendation**:
- Is the current free default (`qwen3.6-35b-a3b-fp8`) reliable enough for MCP work?
- If not, which free model should be the default (or whether MCP-heavy members need a different default)?
- A fallback ordering (incl. the best fully-private local option).

**No auto-change** — the report recommends; changing the provisioned default (`provision-user.ts`) is the owner's call in a follow-up.

## Out of scope

- **DGX Spark** benchmarking (needs a `/dgx` proxy route) — deferred follow-up.
- **In-product benchmark UI** — this is a script + report, not a playground feature (the existing `knowledge/benchmarks` tab is RAG-QA, a different concern).
- **Paid models** (ChatGPT/Anthropic) — A1 is about the *free* default; paid is the member's own connected upgrade (A2) or the department backstop.
- **Vision/audio** tasks; broad statistical rigor (single run per task on a focused set).

## Open items to confirm during planning

- The exact mechanism to read the outbound **trace** rows for the "tool-invoked" check (the pi harness records tool calls; confirm the trace shape + how to query it per session, mirroring how `chat.js` skips `kind:'trace'` rows).
- Ground-truth computation per MCP task — call the tool directly via the relay, or parse the reference model's tool output; pick the robust approach.
- Scratch-group lifecycle (provision one reusable group and re-point its model per candidate, vs. one per model) and clean teardown.
- Exact courses/rooms/policy values to probe (pick ones with stable, checkable answers).
