# Knowledge tab — ingestion + storage spec

Design spec for the ingestion side of the Knowledge tab (Phase 4 in the
vision, Phase 7 in master.md). The strategy/query side (pipeline builder,
chunk→embed→retrieve→rerank→prompt) is already sketched in the vision;
this doc covers what comes before: how a corpus gets built and how it gets
stored.

## Teaching intent

Every decision in this flow is a teachable tradeoff. The ingestion tab is
not a utility — it IS the curriculum. Students should:

1. Choose a source, see what the raw extraction actually looks like, and
   encounter its failure modes before the extracted text reaches a chunker.
2. Choose a storage strategy, run the same test query across strategies,
   and see concretely what each one gets right and wrong.
3. Understand when RAG is the wrong tool (structured data → direct query;
   very dynamic data → agentic retrieval; very long single document →
   summarization).

## Two-tab structure

```
Knowledge tab
├── Ingest sub-tab  — build a named corpus from one or more sources
└── Strategy sub-tab — author a retrieval pipeline that queries a corpus
```

A named corpus is the shared artifact: Ingest produces it, Strategy
consumes it. Students can build one corpus and compare multiple strategies
against it, or compare corpora built from the same source with different
extraction/chunking settings.

---

## Source taxonomy

### Category 1 — Clean text
Markdown, HTML, README files, policy docs, syllabus pages.

- **Extraction:** strip tags / front-matter, minimal cleaning.
- **Teaching angle:** baseline. Everything works. Used to establish a
  quality floor before introducing harder sources.
- **Input:** file upload or paste.

### Category 2 — Messy documents
PDFs (native and scanned), slide decks (.pptx), Word docs (.docx).

- **Extraction:** PyMuPDF / pdfminer for native PDF; Tesseract for scanned;
  python-pptx or LibreOffice headless for slides/Word.
- **Teaching angle:** extraction quality IS the lesson. Two-column layouts,
  footnotes, figure captions, headers/footers, and tables all break naive
  extractors in instructive ways. Scanned PDFs introduce OCR confidence
  scores.
- **Input:** file upload.

### Category 3 — Structured / semi-structured
CSV, spreadsheets, JSON, catalogs, schedules.

- **Extraction:** pandas read → row/record serialization to text; or direct
  schema-aware serialization.
- **Teaching angle:** "should you even RAG this?" Tabular data with exact
  values (dates, prices, IDs) is almost always better served by a SQL/tool
  query than by embedding similarity. The ingestion tab can surface a
  recommendation: prose → RAG, tabular → tool/direct-query.
- **Input:** file upload or GWS Sheets (already wired via GWS MCP).

### Category 4 — Dynamic / personal
Email, calendar, task lists, GitHub issues, LMS content.

- **Extraction:** pull via existing tools (GWS MCP for Drive/Docs/Gmail/
  Calendar; GitHub API; LMS export).
- **Teaching angle:** permissions, freshness, and re-ingestion scheduling.
  Who can see what? When does the corpus go stale? What triggers a
  re-index? This category naturally leads to "agentic retrieval" — maybe
  you shouldn't pre-index at all, just let the agent fetch on demand.
- **Input:** GWS OAuth (already wired), GitHub token, LMS export upload.

### Category 5 — Web sources
Public docs, standards pages, product documentation, APIs.

- **Extraction:** Playwright crawl + Readability/trafilatura for main
  content extraction; robots.txt / ToS check.
- **Teaching angle:** crawling depth, stale content, citation hygiene,
  rate limiting, and the difference between "crawlable" and "you should
  crawl this."
- **Input:** URL or sitemap.

### Category 6 — YouTube
Video with transcripts (auto-generated or manual captions).

- **Extraction:** yt-dlp for transcript + metadata; timestamps preserved
  as chunk metadata so retrieved chunks cite a timecode.
- **Teaching angle:** transcript quality variance (coding tutorial
  auto-captions vs. a captioned lecture), chapter markers as natural
  chunk boundaries, copyright / ToS as a real constraint.
- **Input:** YouTube URL or playlist.

### Category 7 — POV / screen-recording video
Instructor recordings, lab walkthroughs, coding sessions.

- **Extraction (audio):** Whisper for transcription; timestamps preserved.
- **Extraction (visual):** frame sampling at configurable interval +
  vision-model description of frame content (code on screen, terminal
  output, diagrams). Multimodal: audio transcript + visual frame
  descriptions are both indexed.
- **Teaching angle:** frontier territory — students won't find a clean
  tutorial. Audio track vs. visual track carry different information in a
  coding session. This is the hardest category and deliberately so.
- **Input:** file upload (mp4/mov) or local path.

### Category 8 — Reference books
Textbooks, technical books, long structured PDFs.

- **Extraction:** PyMuPDF; ToC parsing for section structure; equations
  flagged (MathJax / LaTeX passthrough or description).
- **Teaching angle:** long-document chunking strategy. Page boundary →
  loses chapter context. Section boundary → better but requires ToC
  parsing. Parent-child chunking (small retrieval chunk + larger context
  window expansion) is the production answer. Figures, tables, and
  equations all break naive extractors.
- **Input:** file upload. (Copyright note surfaced in UI — students supply
  their own licensed copy.)

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

- **Re-ingestion scheduling** (category 4/5): how frequently does a
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
- **Copyright surface**: UI should surface a note for categories 6/8
  where ToS / copyright is a real constraint. Not a blocker but
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
