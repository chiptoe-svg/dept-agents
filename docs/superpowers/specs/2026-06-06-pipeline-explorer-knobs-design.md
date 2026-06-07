# Ingestion & Retrieval Pipeline Explorer — Design

**Date:** 2026-06-06
**Status:** Design — awaiting review
**Author:** brainstorming session (chiptoe + Claude)

## Goal

Give students a hands-on way to explore how ingestion and retrieval *choices*
change results. They compose one pipeline (chunker + engine), build it, run a
sample query, and tweak query-time knobs (top-k, hybrid blend) to **see the
ranking change live**. The teaching payoff: "keyword vs. semantic retrieval,
chunk size, and blend weighting are knobs with visible consequences."

This is a classroom teaching tool. It runs in the playground, per agent group,
on the Mac Studio production install. It reuses the existing `src/knowledge/`
engine — no new retrieval infrastructure.

## Scope decisions (locked during brainstorming)

- **Shape:** pipeline *builder*, not a fixed comparison grid. Student composes
  the stages.
- **Menu richness:** "more knobs" on the existing engines — no new embedder, no
  local/Clemson embedding path (deferred), no RRF.
- **Comparison model:** **one pipeline, live knobs.** Tweak query-time knobs and
  watch results re-run instantly; comparing two *ingest* strategies means
  rebuilding, not a side-by-side 2-pane diff.
- **Placement:** enhance the **existing Sources + Retrieval tabs** and make them
  **student-visible** — do not build a new tab, do not refactor/consolidate the
  admin tabs.
- **Hybrid fusion:** **weighted normalized scores** —
  `fused = α·denseNorm + (1−α)·bm25Norm`, each engine min-max normalized to
  0–1. `α=0` → pure BM25, `α=1` → pure Dense.

## Non-goals (YAGNI)

- No saved/named pipelines or a "shelf" of configs.
- No new embedding model or local/Clemson embedder.
- No Reciprocal Rank Fusion.
- No changes to the Benchmarks tab.
- No agent-side (`knowledge_search`) changes — but see the Dense-only warning
  below.

## The ingest-time vs. query-time split (core architecture)

The single most important distinction the UI must encode:

| Knob | When it applies | Cost | UX |
|------|-----------------|------|-----|
| Chunker (sentence/fixed) | ingest | rebuild | Sources tab |
| Chunk size | ingest | rebuild | Sources tab |
| Overlap (fixed chunker only) | ingest | rebuild | Sources tab |
| Engine (BM25 / Dense / Hybrid) | ingest | rebuild (Dense = OpenAI embed calls) | Sources tab |
| top-k | query | instant | Retrieval tab |
| Hybrid blend α | query | instant | Retrieval tab (hybrid corpora only) |

Ingest-time changes set a `needsRebuild` flag and require an explicit
**Build / Rebuild** button. Query-time knobs re-run `handleQuery` with no
rebuild.

## Components & changes

### Engine (`src/knowledge/`)

1. **`stages/chunk.ts`** — already parameterized:
   - `chunkFixed(text, corpusId, source, targetTokens=512, overlapTokens=64)`
   - `chunkSentence(text, corpusId, source, maxSentencesPerChunk=8)`

   No signature change needed. The "size" knob is **engine-specific**:
   - Fixed chunker → `targetTokens`, presets **256 / 512 / 1024 tokens**, with
     an overlap preset (`overlapTokens`).
   - Sentence chunker → `maxSentencesPerChunk`, presets **4 / 8 / 16 sentences**,
     no overlap (the sentence chunker has no overlap concept; the UI hides the
     overlap control when sentence is selected).

   The UI swaps the size preset list (and shows/hides overlap) based on the
   selected chunker.

2. **`pipeline.ts` `runTextPipeline`** — currently calls
   `chunkFixed(text, id, file)` / `chunkSentence(text, id, file)` with hardcoded
   defaults. Change: read `meta.chunkSize` and `meta.overlap` and pass them
   through. Clear `needsRebuild` on success.

3. **`types.ts` corpus meta** — add fields: `chunkSize?: number`,
   `overlap?: number`, `needsRebuild?: boolean`. Defaults preserve current
   behavior (512 / 64).

4. **New fusion function** (`src/knowledge/stages/fuse.ts` or inline in
   `api-handlers.ts`): given BM25 results and Dense results plus `α`, min-max
   normalize each result set's scores to 0–1, compute
   `fused = α·denseNorm + (1−α)·bm25Norm` per chunk (union of both result sets;
   a chunk missing from one engine contributes 0 for that side), sort desc,
   return top-k. Pure function, unit-tested.

5. **`api-handlers.ts` `handleQuery`** — accept `k` (default 5) and `alpha`
   (default 0.5, hybrid only). For hybrid, call the fusion function; for
   single-engine, pass through existing behavior. Return per-engine sub-scores
   alongside the fused score so the UI can show the breakdown.

### Playground UI

6. **Sources tab (`public/tabs/sources.js`)** — add to the existing strategy-card
   block: a chunker selector (sentence / fixed), an engine-specific size selector
   (fixed → **256 / 512 / 1024 tokens**; sentence → **4 / 8 / 16 sentences**),
   and an overlap selector (**0 / 64 / 128 tokens**, shown only for the fixed
   chunker). Wire to corpus `meta`. Changing any ingest knob marks the corpus
   "needs rebuild" (visual badge) and the Build button becomes "Rebuild." Before
   a Dense/Hybrid rebuild, show *"Will embed N chunks via OpenAI."*
   Add a one-line warning on Dense-only: *"Dense-only corpora work here but your
   agent's `knowledge_search` is BM25-only — pick Hybrid if the agent needs to
   search this."*

7. **Retrieval tab (`public/tabs/retrieval.js`)** — add a **top-k slider** (1–20)
   and, for hybrid corpora, a **BM25↔Dense blend slider** (α, 0–1). Both re-run
   `handleQuery` on change (debounced) and re-render. Show one fused ranked list
   with per-row `fused / bm25 / dense` columns so students see why the order
   shifts. For non-hybrid corpora, hide the α slider.

8. **Routes (`api-routes.ts`)** — thread `k` + `alpha` query params into
   `handleQuery`. No new endpoints.

9. **Student visibility** — add `sources` and `retrieval` to
   `tabsVisibleToStudents` in `config/class-controls.json` and to the
   `DEFAULT_CLASS_CONTROL` in `src/channels/playground/api/class-controls.ts`.

## Data flow

**Build (ingest-time):** Sources tab writes chunker/size/overlap/engine to
corpus `meta` → student clicks Build/Rebuild → `POST …/ingest` →
`runTextPipeline` reads `meta`, chunks with the chosen params, builds BM25
and/or Dense indexes → status `ready`, `needsRebuild=false`.

**Query (query-time):** Retrieval tab → `GET …/query?q=…&k=…&alpha=…` →
`handleQuery` runs BM25 and/or Dense, fuses if hybrid → returns ranked chunks
with fused + per-engine scores → UI renders. Moving top-k or α re-issues the
request; no rebuild.

## Error handling / edge cases

- BM25-only corpus → α slider hidden (nothing to blend); only top-k shown.
- Dense-only corpus → Sources warns it's invisible to the agent's
  `knowledge_search` (BM25-only); Retrieval lab still queries it fine.
- Failed ingest → friendly corpus-status error surfaced in Sources, not the raw
  stringified stack `runTextPipeline` currently stores.
- Rebuild cost guard → chunk size/overlap are presets (not free text); rebuild
  is explicit; Dense rebuild shows the embed-count note first.
- Bounds → top-k 1–20; α 0–1; overlap forced < size; sentence chunker disables
  overlap.
- Concurrent students → corpora are per-agent-group dirs (already isolated); the
  existing `embedChunks` batchSize bounds API pressure. No new locking.

## Testing

- Unit: `chunkFixed` / `chunkSentence` across size+overlap — overlap ≥ size,
  tiny docs (≤ one chunk), exact-boundary, sentence chunker ignores overlap.
- Unit: fusion fn — `α=0` reproduces pure-BM25 order, `α=1` pure-Dense order,
  normalization with a single result (no divide-by-zero), chunk present in only
  one engine, tie handling.
- Unit: `handleQuery` honors `k` and `alpha`; hybrid path returns per-engine
  sub-scores.
- Update existing `pipeline.test.ts` / `corpus.test.ts` for the new `meta`
  fields (defaults preserve old behavior).
- Manual smoke: build a hybrid corpus, slide α 0→1 and confirm rows reorder;
  change chunk size and confirm "needs rebuild" badge; rebuild and confirm chunk
  count changes.

## Open questions

None blocking. Deferred: local/Clemson embedder option (privacy + cost lesson),
RRF as a second fusion mode, persisting a named pipeline for later comparison.
