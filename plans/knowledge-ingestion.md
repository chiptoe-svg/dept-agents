# Sources + Retrieval tabs — ingestion + storage spec

Design spec for the two RAG lab-bench tabs that replace the single
"Knowledge" tab from the original vision. Referenced as Phase 4 in the
vision doc and Phase 7 in master.md.

## Core framing: both tabs are lab benches

A lab bench is not a configuration panel. Students don't set things up
and walk away — they make a change and immediately see the result. Every
control has visible feedback. Every decision produces observable output.
This framing governs both tabs:

- **Sources** — a bench for building named corpora. Change the extraction
  strategy, see the raw chunks update. Change the storage strategy, see
  the cost estimate update. Commit when satisfied.
- **Retrieval** — a bench for designing retrieval pipelines. Type a test
  query, see the retrieved chunks in real time. Swap a corpus or change
  a reranker, see the results change. The query input is always visible;
  nothing requires leaving the tab to see the effect of a change.

Neither tab is a slideshow about RAG. The learning happens at the bench.

## Teaching intent

Every decision in this flow is a teachable tradeoff:

1. Choose a source, see what the raw extraction actually looks like, and
   encounter its failure modes before the extracted text reaches a chunker.
2. Choose a storage strategy, run the same test query across strategies,
   and see concretely what each one gets right and wrong.
3. Understand when RAG is the wrong tool (structured data → direct query;
   very dynamic data → agentic retrieval; very long single document →
   summarization).

## Two-tab structure

```
Sources tab    — lab bench for building named corpora
                 (source → extract → chunk → store)

Retrieval tab  — lab bench for designing retrieval pipelines
                 (corpus → retrieve → rerank → prompt → response)
```

A named corpus is the shared artifact: Sources produces it, Retrieval
consumes it. Students can build one corpus and compare multiple retrieval
strategies against it, or compare corpora built from the same source with
different extraction/storage settings — the bench makes both comparisons
immediate and visual.

---

## UI: progressive disclosure

All source categories and all extraction/storage strategies are available,
but nothing is overwhelming on first contact. Entry point is a source
picker + named preset cards; depth is revealed by expanding steps.

### Three disclosure layers

**Layer 0 — always visible**
Source picker (Upload / YouTube / URL / GWS / …) and four preset cards.
Selecting a source + preset and hitting "Build corpus" is the complete
happy path. A live cost estimate updates as selections change.

**Layer 1 — expand a preset (one click per step)**
The preset unfolds into its pipeline steps as expandable pills. Each pill
shows what the preset chose; clicking it opens Layer 2 for that step.

```
Extract → [V2: Whisper]   Chunk → [sentence]   Store → [hybrid]
```

**Layer 2 — step settings**
Model pickers, numeric controls, prompt overrides. For example, expanding
the Extract pill on a video corpus reveals the V1–V5 selector and, for V3+,
the frame interval and vision model choice.

### Named presets

Presets are the pedagogical on-ramp. Each is a fully specified pipeline
that a student can use as-is or fork. Forking one variable updates the
preset label to "Standard (modified)" and recalculates the cost estimate —
that delta IS the lesson.

| Preset | Extract | Chunk | Store | Cost |
|---|---|---|---|---|
| **Quick** | V1 transcript / text strip | fixed-512 | BM25 keyword | free |
| **Standard** | V2 Whisper / PyMuPDF | sentence boundary | hybrid BM25 + embedding | low |
| **Deep** | V4 transcript-guided frames | section / hierarchical | hybrid + parent-child | medium |
| **Frontier** | V5 video snippets / full multimodal | semantic breakpoints | hybrid + graph | high |

Non-video sources use the equivalent extraction tier (V1 = existing
transcript or plain text; V2 = Whisper / OCR; V4 = LLM-guided extraction;
V5 = vision model over figures/pages).

### Corpus inspection panel

Before committing a corpus build, students see:
- Raw extracted text sample (first 3 chunks)
- Chunk count + estimated token total
- Cost breakdown per step (embedding tokens, vision model calls, Whisper
  minutes)
- For video: a sample frame with its generated description

This is not a confirmation dialog — it is part of the curriculum. Seeing
that a 90-minute lecture yields 3,200 chunks at $0.32 with ada-002 vs.
$0.00 with BGE-small is a concrete data point, not a footnote.

---

## Source taxonomy — five sub-tabs

The Sources tab is organized into five sub-tabs. Each sub-tab is a named entry
point; the pipeline steps (extract → clean → chunk → store) are the same across
all of them but with modality-specific defaults pre-filled.

A sixth category (Live/Dynamic data) is deferred — see Open questions below.

### Sub-tab: PDF

Native PDFs, scanned PDFs, slide decks (.pptx), Word docs (.docx), textbooks,
and other long structured PDFs.

- **Extraction:** PyMuPDF / pdfminer for native PDF; Tesseract for scanned;
  python-pptx or LibreOffice headless for slides/Word; ToC parsing for
  textbooks.
- **Teaching angles:**
  - *Messy documents:* Two-column layouts, footnotes, figure captions,
    headers/footers, and tables all break naive extractors in instructive
    ways. Scanned PDFs introduce OCR confidence scores.
  - *Long books:* Long-document chunking strategy — page boundary → loses
    chapter context; section boundary → better but requires ToC parsing;
    parent-child chunking is the production answer. Equations and figures
    break naive extractors.
- **Input:** file upload. (Copyright note surfaced for textbooks — students
  supply their own licensed copy.)

### Sub-tab: Video

YouTube videos (with auto-generated or manual captions) and uploaded video
files (instructor recordings, lab walkthroughs, coding sessions, screen
recordings).

- **Input:** YouTube URL or playlist; file upload (mp4/mov) or local path.
- **Teaching angles:**
  - *YouTube:* Transcript quality variance (coding tutorial auto-captions
    vs. a captioned lecture), chapter markers as natural chunk boundaries,
    copyright / ToS as a real constraint.
  - *POV/screen recording:* Audio track vs. visual track carry fundamentally
    different information in a coding session. The five extraction strategies
    below make that tradeoff concrete and measurable.

#### Video extraction strategies

Students pick one strategy per corpus; the same test query can be run across
all five to show the cost/quality curve directly.

| # | Strategy | Cost | Complexity |
|---|---|---|---|
| V1 | Transcript only | free / negligible | trivial |
| V2 | Voice-to-text (Whisper) | compute only | low |
| V3 | Whisper + periodic frame grabs | compute + vision tokens | medium |
| V4 | Whisper + transcript-guided frame selection | compute + LLM + vision | high |
| V5 | Whisper + transcript-guided video snippet analysis | compute + LLM + frontier vision | frontier |

**V1 — Transcript only**
Use the pre-existing transcript: YouTube auto-captions (via yt-dlp),
a provided SRT/VTT file, or a companion `.txt` transcript. Timestamps
preserved as chunk metadata.

- *Good for:* well-captioned lectures, talks with clean audio.
- *Fails on:* auto-captions for technical content (code identifiers,
  library names, jargon); videos where the information is visual (a
  coding session showing what's on screen).
- *Teaching angle:* fastest path; establishes the quality floor.
  Auto-caption accuracy on "NumPy broadcasting" vs. "And then we
  add the arrays" shows the gap immediately.

**V2 — Voice-to-text (Whisper)**
Transcribe the audio track with Whisper (local, runs on MLX).
No existing caption file required. Timestamps at word or segment
level.

- *Good for:* any video with intelligible speech; instructor recordings
  with no published transcript.
- *Fails on:* same visual-content gap as V1 — the transcript only
  knows what was said, not what was shown.
- *Teaching angle:* model size tradeoff (whisper-tiny vs. whisper-large
  — speed vs. accuracy on technical vocabulary). Local = free but
  takes real time on a 60-min lecture.

**V3 — Whisper + periodic frame grabs**
V2 transcript plus a screenshot every N seconds (configurable: 5s /
15s / 30s). Each frame is described by a vision model and the
description is appended to the nearest transcript chunk.

- *Good for:* getting visual context into the index without expensive
  per-frame targeting.
- *Fails on:* N=5s → mostly redundant frames (same slide for 2 min);
  N=30s → misses fast-moving content. Most frames are irrelevant noise.
- *Teaching angle:* brute-force multimodal. The N parameter is itself
  a lesson — there is no good fixed value. Motivates V4.

**V4 — Whisper + transcript-guided frame selection**
Use the transcript to identify "high-signal moments" — phrases like
"as you can see here", "look at this output", "here's the error",
transitions between topics — then grab frames only at those
timestamps. LLM call over transcript segments to score frame-worthiness
before any vision model is invoked.

- *Good for:* coding walkthroughs, lab demos, any video where the
  speaker explicitly points to visual content.
- *Fails on:* videos where important visual events happen silently (a
  graph appearing, a terminal filling with output while the speaker
  is quiet).
- *Teaching angle:* the transcript IS a table of contents for the
  visual track. Using one modality to guide extraction of the other
  is the key insight. Significantly better signal-to-noise than V3 at
  comparable or lower cost.

**V5 — Whisper + transcript-guided video snippet analysis**
V4's targeted frame selection, but instead of (or in addition to)
still frames, extract short video clips (2–10 sec) at high-signal
moments and send to a video-capable vision model for analysis.

- *Models:* GPT-4o (video input via API), Gemini 1.5/2.0 Flash
  (long video context), or **Gemma 4 local** (multimodal, runs on
  MLX — free but GPU-heavy; viable on Mac Studio, marginal on Pi).
- *Good for:* fast UI interactions, terminal output scrolling, animated
  diagrams, anything where a single frame loses temporal context.
- *Fails on:* cost — video tokens are expensive at API rates. Gemma 4
  local avoids the cost but requires significant VRAM.
- *Teaching angle:* frontier territory. Students can measure whether
  the quality gain over V4 justifies the cost. The local-vs-API
  tradeoff (Gemma 4 vs. GPT-4o) is a concrete, measurable decision.

### Sub-tab: Text

Clean text sources (Markdown, HTML, README files, policy docs, syllabus pages),
web pages and documentation sites, and long prose documents (contracts, reports,
articles).

- **Extraction:** strip tags / front-matter, minimal cleaning for clean text;
  Playwright crawl + Readability/trafilatura for web sources; robots.txt / ToS
  check for crawled sites.
- **Teaching angles:**
  - *Clean text:* baseline. Everything works. Used to establish a quality floor
    before introducing harder sources.
  - *Web sources:* crawling depth, stale content, citation hygiene, rate
    limiting, and the difference between "crawlable" and "you should crawl
    this."
- **Input:** file upload, paste, URL, or sitemap.

### Sub-tab: Complex

CAD drawings, diagrams, charts, photographs, figures from papers, 3D files,
infographics, and other non-text-primary visual documents.

- **Extraction:** vision model description per figure/page (GPT-4o vision,
  Gemini Flash vision, or Gemma 4 local for offline/free); layout analysis
  to detect figure vs. text regions; optional LaTeX/MathJax passthrough for
  equations.
- **Teaching angles:**
  - Vision models turn visual information into retrievable text — but the
    description quality is model-dependent and lossy.
  - CAD/3D files have no text track at all; the extraction step IS a
    description step. Students see directly that the index quality depends
    entirely on the description quality.
  - Motivates the question: for highly visual content, is RAG even the right
    pattern, or should the agent see the image directly at query time?
- **Input:** file upload (PNG, JPG, PDF with figures, DXF, STL, etc.).

### Sub-tab: Data

CSV files, spreadsheets, JSON, catalogs, schedules, and other structured or
semi-structured tabular data.

- **Extraction:** pandas read → row/record serialization to text; or direct
  schema-aware serialization. Column headers + row values → natural-language
  sentences or JSON records.
- **Teaching angle:** "should you even RAG this?" Tabular data with exact
  values (dates, prices, IDs) is almost always better served by a SQL/tool
  query than by embedding similarity. The Sources tab surfaces a
  recommendation: prose → RAG, tabular → tool/direct-query. Knowing when
  NOT to use RAG is part of knowing RAG.
- **Input:** file upload or GWS Sheets (already wired via GWS MCP).

### Open question: Live / Dynamic data (deferred)

Email, calendar, task lists, GitHub issues, LMS content, and other
continuously-updated personal or organizational data.

- **Why deferred:** permissions, freshness, and re-ingestion scheduling add
  significant complexity beyond one-time ingest. First version of the Sources
  tab is one-time ingest only.
- **Teaching angle when implemented:** Who can see what? When does the corpus
  go stale? What triggers a re-index? This category naturally leads to
  "agentic retrieval" — maybe you shouldn't pre-index at all, just let the
  agent fetch on demand.
- **Input (when implemented):** GWS OAuth (already wired), GitHub token, LMS
  export upload.

---

## Storage strategies

The "store" step is where students make an explicit choice. The same
extracted + chunked corpus should be indexable under any strategy so
the test-query panel (already in the vision mockup) can run
apples-to-apples comparisons.

### Strategy A — Keyword index (BM25 / SQLite FTS)
Inverted index over tokens. No embeddings. Exact and partial term match.

- **Good for:** precise terminology, code identifiers, named entities,
  exact quotes.
- **Fails on:** synonyms, paraphrases, conceptual queries with no
  lexical overlap.
- **Why teach it first:** fast, fully explainable, zero cost. Establishes
  why semantic search exists.
- **Implementation:** SQLite FTS5 (already a dep) — zero new infra.

### Strategy B — Dense embedding + vector store
Embed each chunk; store vectors; ANN retrieval at query time.

- **Good for:** semantic similarity, paraphrases, cross-lingual.
- **Fails on:** exact-match queries, rare terms, out-of-distribution
  domains if the embedding model wasn't trained on them.
- **Embedding model choice:** `text-embedding-ada-002` (OpenAI, cost),
  `BGE-small` or `nomic-embed` (local MLX, free, slower), `all-MiniLM`
  (tiny, fast, weaker). Model choice is itself a teachable variable.
- **Vector store:** Chroma (in-process, no infra) or Qdrant (separate
  process, production-realistic). Start with Chroma.
- **Teaching angle:** embedding model choice matters. Same corpus, same
  query, different model → different top-k.

### Strategy C — Hybrid (BM25 + dense, RRF fusion)
Run both A and B; fuse rankings with Reciprocal Rank Fusion.

- **Good for:** most real queries (some need exact match, some need
  semantic).
- **Teaching angle:** why neither A nor B alone is the production answer.
  RRF is simple and robust; weighted linear combination is an alternative.

### Strategy D — Knowledge graph
Entity extraction → triples → graph index. Multi-hop traversal at
query time.

- **Good for:** "who collaborated with X?", "what caused Y?",
  multi-hop relationship queries that dense retrieval misses entirely.
- **Fails on:** open-ended semantic search; queries with no clear entity
  anchor.
- **Teaching angle:** when structured knowledge beats fuzzy similarity.
  Also: graph construction quality depends on the extraction LLM, so
  the corpus quality problem moves upstream.
- **Implementation:** entity/triple extraction via LLM call during
  ingest; store in SQLite as `(subject, predicate, object)` triples +
  adjacency; query via BFS/DFS or LLM-guided traversal.
  (Neo4j is overkill for classroom scale; SQLite graph is sufficient
  and keeps the infra surface flat.)

### Strategy E — Hierarchical / parent-child
Chunk at two granularities: small chunks for retrieval, large parent
chunks for context. Retrieve small, return parent.

- **Teaching angle:** context window management. The retrieval precision
  vs. context richness tradeoff. Directly relevant to the "how much
  context do I give the LLM?" question students will ask.

### Strategy F — Summary index
LLM-generated section/chapter summaries stored as index nodes alongside
raw chunks. Summary retrieval for coarse routing, chunk retrieval for
fine-grained answer.

- **Teaching angle:** retrieval as a two-stage problem. Also: the summary
  costs tokens to generate but improves recall on broad questions.

---

## Ingestion pipeline (per source)

```
source
  └─ extract          (modality-specific: text/OCR/Whisper/frames/crawl)
       └─ clean       (dedup, normalize whitespace, remove boilerplate)
            └─ chunk  (fixed-size / sentence / section / semantic)
                 └─ embed / index  (strategy-dependent)
                      └─ store → named corpus
```

Each step is configurable and its output is inspectable in the UI before
the pipeline is committed. Students should be able to see the raw
extracted text, the chunk boundaries, and (for embedding strategies) a
sample of nearest-neighbor chunks for a probe query — all before saving
the corpus.

### Chunk strategy options
| Strategy | Good for | Failure mode |
|---|---|---|
| Fixed-size (512 tokens, 64 overlap) | baseline | splits mid-sentence, mid-concept |
| Sentence boundary | prose | very short sentences → tiny chunks |
| Section / heading boundary | structured docs, books | requires structure parsing |
| Semantic (embedding similarity breakpoints) | heterogeneous docs | slow, requires embed pass |
| Recursive character splitter | general fallback | good default |

---

## Open questions / out of scope for this spec

- **Re-ingestion scheduling** (Live/Dynamic sub-tab): how frequently does a
  dynamic corpus re-pull? Trigger-based (webhook) vs. cron. Deferred —
  first version is one-time ingest only.
- **Multi-source corpora**: can a corpus mix a PDF + a YouTube transcript
  + a GWS Doc? Probably yes; the chunk metadata carries source provenance.
  Design deferred.
- **Corpus versioning**: named snapshots so students can compare
  "corpus v1 (raw PDF)" vs. "corpus v2 (cleaned + section-chunked)".
  Useful but not required for Phase 7.
- **Cost guardrails**: embedding 10,000 chunks with ada-002 costs real
  money. The ingestion tab should show a cost estimate before committing.
- **Copyright surface**: UI should surface a note for the Video and PDF
  sub-tabs where ToS / copyright is a real constraint. Not a blocker but
  pedagogically important.
- **Graph implementation detail**: SQLite triples vs. a lightweight graph
  lib (networkx in-memory). Decision deferred to implementation.

---

## Relationship to master.md

This spec covers the ingestion half of **Phase 7** (classroom-web-multiuser.md §Phase 7
"expert system builder + RAG strategies") and feeds into **Phase 8**
(evaluation framework). Phase 8's side-by-side comparison only makes
sense once students have built multiple strategies against the same
corpus, which requires the storage-strategy picker this spec defines.

Phase 7 implementation plan (not yet written) should reference this doc
for the source taxonomy and storage strategy interfaces.
