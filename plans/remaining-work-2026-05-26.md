# Remaining work — audit 2026-05-26

> Cross-references the 15 plans under `docs/superpowers/plans/` and `plans/` against the public roadmap at `docs/vision/index.html`. Cite this doc when the vision page or state.md is being updated.

## What's been done

All multi-task plans have shipped except `2026-05-15-classroom-per-person-mode.md` (Phase 14 + downstream phases 6/8/9). Specifically:

| Plan | Status |
|---|---|
| `2026-05-13-agent-playground-v3.html` (24 tasks) | shipped |
| `2026-05-14-omlx-local-model-integration.md` | shipped |
| `2026-05-17-per-student-provider-auth.md` | shipped (X.7 + Home Providers card) |
| `2026-05-21-agent-export.md` (6 phases) | shipped |
| `2026-05-21-agent-library.md` | shipped (modal builder bug fixed 2026-05-26) |
| `2026-05-21-rag-phase7a.md` (Sources + Retrieval tabs) | shipped |
| `2026-05-21-rag-phase7b-dense.md` | shipped |
| `2026-05-21-rag-phase7b-pdf.md` | shipped |
| `2026-05-21-rag-phase7c-benchmarks.md` (Benchmarks tab) | shipped |
| `2026-05-21-rag-phase7d.md` (`knowledge_search` MCP tool) | shipped |
| `2026-05-25-phase-bhalf-container-configs-db.md` | shipped |
| `2026-05-25-phase-c-pi-port.md` | shipped |
| `2026-05-25-phase-d-pi-sole-harness.md` | shipped (tag `phase-d-complete-2026-05-26`) |
| `2026-05-26-multi-provider-models-tab.md` (16 mptab tasks + Clemson) | shipped |

The older `plans/` directory contains finished arcs (playground v2, classroom rosters, credential-proxy attribution, etc.) and a smattering of pre-pi audits — all closed or absorbed into the v2/pi tracks.

## What remains

### 1. Phase 14 — per-person GWS OAuth (BLOCKED on operator)

- Code in `main`. `wasFallback`-tagged principal infra is shipped; switch is gated only by 5-minute GCP Console click-through (add redirect URI, add test users, request `calendar.readonly` / `drive.readonly` / `gmail.send` scopes).
- Memory: `project-phase-14-gcp-blocker.md`.
- Next action: user (not Claude) — open Cloud Console for the chiptoe-svg project and update OAuth client.

### 2. GWS V2 surfaces (not started — small)

Each is a thin layer over `googleapis` once Phase 14 unblocks per-person OAuth:

- **13.5b** — Calendar list/create
- **13.5c** — Drive listing
- **13.5d** — Gmail search/send

Estimate: ~half a day each. Need short specs before plan. Channel skill pattern (`/add-gws-calendar`, etc.) — they belong on the `channels` branch, not trunk (see CLAUDE.md rule 5).

### 3. Harness tab (not started — needs spec)

Visualizes the agent's memory tiers, live context-window utilization, compaction trigger, reasoning-effort knob, tool-execution mode. Mockup is in vision HTML under "Five new tabs"; no spec yet.

- Pre-req: pick which container-internal counters are surfaceable through `outbound.db` without breaking the two-DB IO surface. The reasoning-effort knob is already wired (codex `effort: low`); the rest is presentation.
- Next action: brainstorm session → spec under `docs/superpowers/specs/`.

### 4. Classroom Phase 8 — Evaluation framework (not started — needs spec)

LLM-as-judge harness for RAG strategies. The Benchmarks tab (Phase 7C) already does quality scoring against a labeled query set; Phase 8 extends it to side-by-side strategy comparison with cost-normalization. Mockup is in vision HTML under the "Eval" tab card.

- Pre-req: settle on judge model + rubric format. Probably reuses Benchmarks' query store.
- Next action: brainstorm session → spec.

### 5. Classroom Phase 9 — Walkaway cloud deploy (not started — needs spec)

Bundle an agent (config + skills + corpora + persona) into a single-script bootstrap that runs on infrastructure the participant owns. Pairs with Agent Export which already covers the export half.

- Pre-req: pick target deployment surface (Fly.io? Modal? bare VM?). Decide whether session DBs ship with the bundle or get re-initialized.
- Next action: scope-narrowing conversation before brainstorming — this one risks ballooning.

### 6. Minor follow-ups (not arcs)

- **B6 — harness-config A/B in Bench** (from the original agent-benchmark-suite plan). Variant matrix: with/without skills, with/without reasoning, with/without continuation pruning. Skip until a question demands it.
- **OpenAI Platform live model verification.** `openai-platform-spec.ts` mirrors codex's 5 IDs on user's empirical assertion; no live `api.openai.com` invocation yet. Single smoke run.
- **`/codex-auth` daemon** (Phase 2 deferred). ChatGPT subscription OAuth refresh, ~3 h.
- **Trace surfacing for non-Claude providers** (Phase 2 deferred). ~30 min per provider.
- **Live in-browser GCP OAuth smoke** (Phase 2 deferred). Catches console-config drift between deploys.

## Vision page reconciliation (applied this commit)

`docs/vision/index.html` previously marked Phases 5, 5b, 7 as "future"; this commit moves them to "shipped" and rewrites the "Two shipped, two ahead" framing to reflect the actual three-shipped / one-ahead-with-fragments state. Bench / Sources / Retrieval tab cards moved from `future` to `live` tags. Harness and Eval remain `future` tags.

---

## Newly-surfaced arcs (2026-05-26 evening)

Multi-arc planning conversation produced four open candidates. Capturing here so they survive into the next session; brainstorming each individually as we pick them up.

### Arc A — Harness tab (context-window view)

**Status:** Brainstorm in progress, paused mid-flow.

**Decisions made:**
- Audience: students, pedagogical (not instructor-debugging).
- Scope: Tier 2 — compositional breakdown (big live context-window bar + stacked breakdown of what's in it: system prompt / CLAUDE.md / CLAUDE.local.md / each mounted skill / conversation history / last tool result).
- Data source: host-side estimates from files + DB. No container changes. Counts within ~5–10% accuracy (doesn't see container-side auto-compaction or dynamic skill loading).
- Surface: standalone Harness tab (vs Chat-modal or Chat-sidebar variants — both viable as follow-ups).

**Open:** Polling cadence (live vs static-with-refresh-button), session-picker UX, tokenizer choice (cl100k_base via tiktoken is the working assumption), visual treatment (stacked bar vs grouped bars vs cards-per-component), whether the per-turn growth chart from option A makes Tier 2 or stays Tier 3.

**Confirms:** Mockup already exists in `docs/vision/index.html` Harness tab card — uses three memory tiers (Session / CLAUDE.local.md / Wiki). The "Wiki" tier is speculative and does not exist in code today; spec should replace it with "skills" or drop.

### Arc B — Home tab revamp

**Status:** Surfaced, undefined.

User mentioned needing to revamp the Home tab alongside Harness. Scope, audience, and goals are unspecified. Needs its own brainstorming session before any spec.

### Arc C — RAG tabs reshape + Weaviate integration

**Status:** Just surfaced. Probably 3–4 sub-specs.

**Context:** User installed Weaviate 1.37.5 at `127.0.0.1:8090` (empty, all major embedding/reranker/multimodal/generative-search modules pre-loaded). Current Phase 7 RAG storage is hand-rolled (`store-dense.ts` brute-force SQLite cosine + `store-bm25.ts` FTS5) — deliberately tiny so it's readable, but missing ANN, rerankers, multimodal, generative-search.

**User-stated design principles for the RAG-comparison UX:**
- Hide implementation complexity. Focus on **approach, results, time/cost, resources**.
- Pipelines as named presets selected by checkbox; compare 2–4 side-by-side.
- No code visible to students (audience is generative-computing students, not CS).
- Per-pipeline ⓘ button opens a plain-language explanation modal of what the pipeline does.
- Builder-looking UI (dropdowns, knobs) backed by a curated preset registry — combinations that resolve to a real preset, no invalid combos exposed.

**Tab assignments:**
- **Sources** tab → reshape to checkbox-compare for ingestion approaches (PDF text-only vs vision-augmented vs hybrid). Shows chunk quality + cost + time + resources per approach.
- **Retrieval** tab → reshape to checkbox-compare for query pipelines. Shows what each retrieved (plain prose) + latency + cost + resources.
- **Bench** tab → gains a new pipeline-comparison axis that absorbs the dropped Eval-tab role (end-to-end answer quality with LLM-as-judge).
- **Eval** tab → **dropped from roadmap.** Vision page edit needed.

**Likely sub-specs:**
1. **Weaviate adapter + presets registry** (foundation). Lives behind `src/knowledge/stores/weaviate.ts` implementing same `query(corpusDir, q, k)` contract as `store-dense`/`store-bm25`. Presets registry that translates dropdown selections into real pipeline configurations. Probably belongs on a `weaviate` long-lived branch per CLAUDE.md rule 5 (install-specific, not every install will have Weaviate); installed by `/add-weaviate` skill.
2. **Sources tab reshape** (ingestion comparison).
3. **Retrieval tab reshape** (query comparison).
4. **Bench tab pipeline axis** (answer-quality comparison; absorbs Eval).

**Open before specifying any of the above:**
- Embedding routing: do Weaviate's text2vec modules go through nanoclaw's credential proxy (so OAuth + accounting still works), or straight to upstream APIs with Weaviate holding its own keys?
- Multi-tenancy: per-student isolation in one Weaviate vs per-corpus directory mapping.

### Arc D — Vision page reconciliation (Eval drop, Bench expand)

**Status:** Small. Applied alongside this remaining-work update.

Drops the Eval tab card from the "Five new tabs" section, updates the heading + intro, expands the Bench card's description to mention the pipeline-comparison + answer-quality role. Updates Phase 4 checklist to remove the standalone Phase 8 Evaluation entry.

---

## Order of operations (no commitment yet)

The four open arcs are largely independent. Some natural orderings:

- **Harness → Arc C foundation → Arc C tab reshapes** (smallest first, then foundation, then UI). Harness can ship while the Weaviate adapter is being designed.
- **Arc C foundation → Harness → Arc C tab reshapes** (foundation first because it unblocks the most). Requires picking a Weaviate-vs-direct-API stance early.
- **Home revamp → everything else** (only if the Home revamp materially changes what's reachable from the playground).

User decides ordering when ready to brainstorm next arc.
