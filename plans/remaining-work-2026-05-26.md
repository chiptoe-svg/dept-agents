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
