# Phase 7B-Dense — Dense Embeddings + Hybrid Retrieval

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dense vector retrieval (OpenAI `text-embedding-3-small`) alongside BM25, and a hybrid mode that merges both scores. Teaches students the difference between keyword and semantic search side-by-side in the Retrieval tab.

**Architecture:** A new `dense.db` SQLite file sits alongside `bm25.db` in the corpus dir. Embeddings are stored as BLOB (IEEE 754 little-endian Float32). Cosine similarity is computed in JavaScript at query time — no new npm packages. The credential proxy at `http://localhost:3001/openai/v1/embeddings` is used for embedding calls (same route pattern the container uses, but called directly from host-side pipeline code). `StoreStrategy` grows to `'dense' | 'hybrid'`. The Sources tab gains Dense and Hybrid preset cards. The Retrieval tab shows side-by-side BM25 / dense columns when the corpus is hybrid — the key pedagogical payoff.

**Tech Stack:** OpenAI embeddings API (via existing credential proxy at `localhost:3001`), Node native `fetch`, SQLite BLOB via `better-sqlite3` (already a dep), vitest (host tests). **No new npm packages.**

**Proxy URL:** The host-side pipeline code reads `process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001'`. The OpenAI embeddings endpoint is at `{proxyBaseUrl}/openai/v1/embeddings` — matching the `/openai/*` prefix routing in `src/credential-proxy.ts`.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/knowledge/types.ts` | Modify | Add `'dense' \| 'hybrid'` to `StoreStrategy` |
| `src/knowledge/stages/embed.ts` | Create | `embedChunks` — batch-call OpenAI embeddings API via proxy, return `Map<chunkId, Float32Array>` |
| `src/knowledge/stages/embed.test.ts` | Create | Mock `fetch`, test batching and response parsing |
| `src/knowledge/stages/store-dense.ts` | Create | `buildDenseIndex` + `queryDense` — SQLite BLOB, cosine similarity |
| `src/knowledge/stages/store-dense.test.ts` | Create | Real SQLite + synthetic embeddings, no API calls |
| `src/knowledge/corpus.ts` | Modify | `createCorpus` accepts optional `storeStrategy` |
| `src/knowledge/pipeline.ts` | Modify | Add dense / hybrid branch after chunking |
| `src/knowledge/api-handlers.ts` | Modify | `handleQuery` routes by `storeStrategy`; `handleCreateCorpus` accepts `storeStrategy` |
| `src/channels/playground/public/tabs/sources.js` | Modify | Dense + Hybrid preset cards; strategy picker on corpus creation form |
| `src/channels/playground/public/tabs/retrieval.js` | Modify | Side-by-side columns for hybrid; strategy badge on corpus selector |

---

### Task 1: `embed.ts` + tests

**Files:**
- Create: `src/knowledge/stages/embed.ts`
- Create: `src/knowledge/stages/embed.test.ts`

**Success criteria:** `pnpm test -- embed` passes. All tests use mocked `fetch`; no real API calls.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/knowledge/stages/embed.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embedChunks } from './embed.js';
import type { Chunk } from '../types.js';

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c:${i}`,
    corpusId: 'c',
    source: 'f.txt',
    text: `chunk text ${i}`,
    index: i,
  }));
}

/** Build a minimal mock OpenAI embeddings response for n inputs. */
function mockEmbeddingResponse(n: number, dims = 4): object {
  return {
    object: 'list',
    data: Array.from({ length: n }, (_, i) => ({
      object: 'embedding',
      index: i,
      embedding: Array.from({ length: dims }, () => Math.random()),
    })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: n * 10, total_tokens: n * 10 },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('embedChunks', () => {
  it('calls /openai/v1/embeddings with correct body and returns a map', async () => {
    const chunks = makeChunks(3);
    const mockResponse = mockEmbeddingResponse(3, 4);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await embedChunks(chunks, 'http://localhost:3001', 3);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3001/openai/v1/embeddings');
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(chunks.map((c) => c.text));

    expect(result.size).toBe(3);
    for (const chunk of chunks) {
      expect(result.has(chunk.id)).toBe(true);
      expect(result.get(chunk.id)).toBeInstanceOf(Float32Array);
      expect(result.get(chunk.id)!.length).toBe(4);
    }
  });

  it('batches chunks when count exceeds batchSize', async () => {
    const chunks = makeChunks(5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => mockEmbeddingResponse(3, 4) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockEmbeddingResponse(2, 4) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedChunks(chunks, 'http://localhost:3001', 5, 3);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(5);
  });

  it('throws when the API returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));

    await expect(embedChunks(makeChunks(1), 'http://localhost:3001')).rejects.toThrow(
      /embeddings API error.*401/
    );
  });

  it('returns empty map for empty input without calling fetch', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await embedChunks([], 'http://localhost:3001');
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `embed.ts`**

```typescript
// src/knowledge/stages/embed.ts
import type { Chunk } from '../types.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_BATCH_SIZE = 100; // well under the 2048-input limit

/**
 * Call the OpenAI embeddings API (via the credential proxy) for all chunks.
 * Returns a map from chunk.id to the embedding Float32Array.
 *
 * @param proxyBaseUrl  e.g. 'http://localhost:3001'. The endpoint called is
 *                      `{proxyBaseUrl}/openai/v1/embeddings`.
 * @param _dims         Ignored at runtime; used only in tests to verify shape.
 * @param batchSize     Max inputs per API call (default 100; API max is 2048).
 */
export async function embedChunks(
  chunks: Chunk[],
  proxyBaseUrl: string,
  _dims?: number,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>();
  if (chunks.length === 0) return result;

  const url = `${proxyBaseUrl.replace(/\/$/, '')}/openai/v1/embeddings`;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch.map((c) => c.text),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embeddings API error ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    for (const item of data.data) {
      const chunk = batch[item.index];
      result.set(chunk.id, new Float32Array(item.embedding));
    }
  }

  return result;
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- embed
```

---

### Task 2: `store-dense.ts` + tests

**Files:**
- Create: `src/knowledge/stages/store-dense.ts`
- Create: `src/knowledge/stages/store-dense.test.ts`

**Success criteria:** `pnpm test -- store-dense` passes. Tests use real `better-sqlite3` with synthetic embeddings (no API calls).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/knowledge/stages/store-dense.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDenseIndex, queryDense } from './store-dense.js';
import type { Chunk } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dense-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c:${i}`,
    corpusId: 'c',
    source: 'f.txt',
    text: `chunk ${i}`,
    index: i,
  }));
}

/** Unit vector pointing entirely in one dimension — maximally distinct for cosine similarity tests. */
function unitVec(dims: number, hotIndex: number): Float32Array {
  const v = new Float32Array(dims);
  v[hotIndex] = 1.0;
  return v;
}

describe('buildDenseIndex', () => {
  it('creates dense.db in the given dir', () => {
    const chunks = makeChunks(3);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
      ['c:2', unitVec(4, 2)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);
    expect(fs.existsSync(path.join(tmpDir, 'dense.db'))).toBe(true);
  });

  it('overwrites an existing dense.db', () => {
    const chunks = makeChunks(2);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);
    buildDenseIndex(tmpDir, chunks, embeddings);
    expect(fs.existsSync(path.join(tmpDir, 'dense.db'))).toBe(true);
  });

  it('skips chunks that have no embedding in the map', () => {
    const chunks = makeChunks(3);
    // Only provide embedding for c:0; c:1 and c:2 have none
    const embeddings = new Map<string, Float32Array>([['c:0', unitVec(4, 0)]]);
    expect(() => buildDenseIndex(tmpDir, chunks, embeddings)).not.toThrow();
  });
});

describe('queryDense', () => {
  it('returns the most cosine-similar chunk first', () => {
    const chunks = makeChunks(3);
    const embeddings = new Map<string, Float32Array>([
      ['c:0', unitVec(4, 0)],
      ['c:1', unitVec(4, 1)],
      ['c:2', unitVec(4, 2)],
    ]);
    buildDenseIndex(tmpDir, chunks, embeddings);

    // Query vector pointing at dimension 1 → c:1 should rank first
    const query = unitVec(4, 1);
    const results = queryDense(tmpDir, query, 3);

    expect(results.length).toBe(3);
    expect(results[0].chunk.id).toBe('c:1');
    expect(results[0].score).toBeCloseTo(1.0, 5);
    // Scores descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score >= results[i].score).toBe(true);
    }
  });

  it('returns at most k results', () => {
    const chunks = makeChunks(5);
    const embeddings = new Map(
      chunks.map((c) => [c.id, unitVec(4, c.index % 4)] as [string, Float32Array])
    );
    buildDenseIndex(tmpDir, chunks, embeddings);
    const results = queryDense(tmpDir, unitVec(4, 0), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when dense.db does not exist', () => {
    const results = queryDense(tmpDir, unitVec(4, 0), 5);
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `store-dense.ts`**

```typescript
// src/knowledge/stages/store-dense.ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Chunk, QueryResult } from '../types.js';

function dbPath(corpusDir: string): string {
  return path.join(corpusDir, 'dense.db');
}

function float32ToBuffer(v: Float32Array): Buffer {
  // Float32Array.buffer is little-endian on every platform Node.js supports.
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy into a fresh ArrayBuffer to guarantee alignment.
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

/** Cosine similarity in [0, 1] for non-zero vectors; 0 if either vector is zero. */
function cosine(a: Float32Array, b: Float32Array): number {
  const denom = norm(a) * norm(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

/**
 * Build (or rebuild) a dense vector index from pre-computed embeddings.
 * Chunks whose id is absent from the embeddings map are silently skipped.
 * Deletes any existing dense.db first.
 */
export function buildDenseIndex(
  corpusDir: string,
  chunks: Chunk[],
  embeddings: Map<string, Float32Array>,
): void {
  const p = dbPath(corpusDir);
  if (fs.existsSync(p)) fs.rmSync(p);

  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE chunk_embeddings (
    chunk_id    TEXT PRIMARY KEY,
    corpus_id   TEXT NOT NULL,
    source      TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text        TEXT NOT NULL,
    embedding   BLOB NOT NULL
  )`);

  const insert = db.prepare(
    'INSERT INTO chunk_embeddings (chunk_id, corpus_id, source, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertAll = db.transaction((rows: Chunk[]) => {
    for (const c of rows) {
      const vec = embeddings.get(c.id);
      if (!vec) continue;
      insert.run(c.id, c.corpusId, c.source, c.index, c.text, float32ToBuffer(vec));
    }
  });
  insertAll(chunks);
  db.close();
}

/**
 * Query the dense index with cosine similarity.
 * Loads all embeddings into memory and ranks them — suitable for corpora up to
 * ~100k chunks at 1536 dims (≈600MB); larger corpora would need an ANN index.
 * Returns up to k results sorted by descending similarity score in [0, 1].
 */
export function queryDense(
  corpusDir: string,
  queryEmbedding: Float32Array,
  k = 5,
): QueryResult[] {
  const p = dbPath(corpusDir);
  if (!fs.existsSync(p)) return [];

  const db = new Database(p, { readonly: true });
  try {
    const rows = db
      .prepare(
        'SELECT chunk_id, corpus_id, source, chunk_index, text, embedding FROM chunk_embeddings'
      )
      .all() as Array<{
        chunk_id: string;
        corpus_id: string;
        source: string;
        chunk_index: number;
        text: string;
        embedding: Buffer;
      }>;

    const scored: QueryResult[] = rows.map((r) => ({
      chunk: {
        id: r.chunk_id,
        corpusId: r.corpus_id,
        source: r.source,
        text: r.text,
        index: r.chunk_index,
      },
      score: cosine(queryEmbedding, bufferToFloat32(r.embedding)),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- store-dense
```

---

### Task 3: Extend types + pipeline

**Files:**
- Modify: `src/knowledge/types.ts`
- Modify: `src/knowledge/corpus.ts`
- Modify: `src/knowledge/pipeline.ts`
- Modify: `src/knowledge/pipeline.test.ts`

**Success criteria:** `pnpm run build` clean. `pnpm test -- pipeline` passes (existing tests still pass, two new dense/hybrid tests pass).

- [ ] **Step 1: Update `types.ts`**

Replace line 4 in `src/knowledge/types.ts`:
```typescript
// Before:
export type StoreStrategy = 'bm25';
// After:
export type StoreStrategy = 'bm25' | 'dense' | 'hybrid';
```

- [ ] **Step 2: Update `corpus.ts` — accept `storeStrategy` in `createCorpus`**

In `src/knowledge/corpus.ts`, update the import to include `StoreStrategy`:
```typescript
import type { CorpusMeta, CorpusStatus, SourceType, StoreStrategy } from './types.js';
```

Update `createCorpus` signature:
```typescript
export function createCorpus(
  folder: string,
  opts: { name: string; sourceType: SourceType; storeStrategy?: StoreStrategy }
): CorpusMeta {
```

Update the `meta` object inside `createCorpus`:
```typescript
  storeStrategy: opts.storeStrategy ?? 'bm25',
```
(replace the hardcoded `'bm25'` on line 40)

- [ ] **Step 3: Replace `pipeline.ts`**

```typescript
// src/knowledge/pipeline.ts
import fs from 'fs';
import path from 'path';
import { corpusDir, readMeta, updateStatus, writeMeta } from './corpus.js';
import { extractText } from './stages/extract-text.js';
import { chunkSentence, chunkFixed } from './stages/chunk.js';
import { buildBm25Index } from './stages/store-bm25.js';
import { embedChunks } from './stages/embed.js';
import { buildDenseIndex } from './stages/store-dense.js';
import type { Chunk } from './types.js';

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';

export async function runTextPipeline(folder: string, id: string): Promise<void> {
  const dir = corpusDir(folder, id);
  try {
    updateStatus(folder, id, 'ingesting');
    const rawDir = path.join(dir, 'raw');
    const files = fs.readdirSync(rawDir).filter((f) => !f.startsWith('.'));
    if (files.length === 0) {
      updateStatus(folder, id, 'error', 'No source files found in raw/');
      return;
    }

    const meta = readMeta(folder, id);
    const allChunks: Chunk[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(rawDir, file), 'utf8');
      const text = extractText(content, file);
      const chunks =
        meta.chunkStrategy === 'fixed'
          ? chunkFixed(text, id, file)
          : chunkSentence(text, id, file);
      allChunks.push(...chunks);
    }

    // Write chunks.jsonl
    const chunksPath = path.join(dir, 'chunks.jsonl');
    fs.writeFileSync(chunksPath, allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

    // Build indexes based on storeStrategy
    if (meta.storeStrategy === 'bm25' || meta.storeStrategy === 'hybrid') {
      buildBm25Index(dir, allChunks);
    }

    if (meta.storeStrategy === 'dense' || meta.storeStrategy === 'hybrid') {
      const embeddings = await embedChunks(allChunks, PROXY_BASE_URL);
      buildDenseIndex(dir, allChunks, embeddings);
    }

    meta.status = 'ready';
    meta.chunkCount = allChunks.length;
    writeMeta(folder, id, meta);
  } catch (err) {
    try {
      updateStatus(folder, id, 'error', String(err));
    } catch {
      // best-effort; ignore if filesystem is unavailable
    }
  }
}

export function readChunks(folder: string, id: string): Chunk[] {
  const p = path.join(corpusDir(folder, id), 'chunks.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Chunk);
}
```

- [ ] **Step 4: Add pipeline tests for dense and hybrid**

Open `src/knowledge/pipeline.test.ts`. Add a `vi.mock` for `embed.ts` at the top of the file (after existing imports):

```typescript
import { vi } from 'vitest';

vi.mock('./stages/embed.js', () => ({
  embedChunks: vi.fn().mockResolvedValue(new Map()),
}));
```

Then add two new `it` cases inside the existing `describe` block:

```typescript
it('calls embedChunks when storeStrategy is dense', async () => {
  const { embedChunks } = await import('./stages/embed.js');
  (embedChunks as ReturnType<typeof vi.fn>).mockClear();

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-dense-'));
  try {
    const meta = createCorpus(folder, { name: 'test', sourceType: 'text', storeStrategy: 'dense' });
    fs.writeFileSync(path.join(corpusDir(folder, meta.id), 'raw', 'a.txt'), 'Hello world.');
    await runTextPipeline(folder, meta.id);

    expect(embedChunks).toHaveBeenCalledTimes(1);
    const finalMeta = readMeta(folder, meta.id);
    expect(finalMeta.status).toBe('ready');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it('calls embedChunks and builds bm25.db when storeStrategy is hybrid', async () => {
  const { embedChunks } = await import('./stages/embed.js');
  (embedChunks as ReturnType<typeof vi.fn>).mockClear();

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-hybrid-'));
  try {
    const meta = createCorpus(folder, { name: 'test', sourceType: 'text', storeStrategy: 'hybrid' });
    fs.writeFileSync(path.join(corpusDir(folder, meta.id), 'raw', 'a.txt'), 'Hello world.');
    await runTextPipeline(folder, meta.id);

    expect(embedChunks).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(corpusDir(folder, meta.id), 'bm25.db'))).toBe(true);
    expect(readMeta(folder, meta.id).status).toBe('ready');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
```

Note: the existing pipeline tests do not import `createCorpus`, `corpusDir`, or `readMeta` — you will need to add those imports to `pipeline.test.ts` if they are not already present.

- [ ] **Step 5: Build and test**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test -- pipeline
```

---

### Task 4: Extend API handlers

**Files:**
- Modify: `src/knowledge/api-handlers.ts`

**Success criteria:** `pnpm test -- api-handlers` passes. `handleCreateCorpus` accepts `storeStrategy`; `handleQuery` dispatches correctly for all three strategies.

- [ ] **Step 1: Add imports**

At the top of `src/knowledge/api-handlers.ts`, update the type import and add new stage imports:

```typescript
// Change:
import type { SourceType } from './types.js';
// To:
import type { SourceType, StoreStrategy, QueryResult } from './types.js';

// Add after existing imports:
import { embedChunks } from './stages/embed.js';
import { queryDense } from './stages/store-dense.js';

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';
```

- [ ] **Step 2: Update `handleCreateCorpus`**

```typescript
export async function handleCreateCorpus(
  folder: string,
  body: { name?: string; sourceType?: SourceType; storeStrategy?: StoreStrategy },
): Promise<HandlerResult> {
  if (!body.name) return { status: 400, body: { error: 'name is required' } };
  const meta = createCorpus(folder, {
    name: body.name,
    sourceType: body.sourceType ?? 'text',
    storeStrategy: body.storeStrategy ?? 'bm25',
  });
  return { status: 201, body: meta };
}
```

- [ ] **Step 3: Replace `handleQuery`**

```typescript
export async function handleQuery(
  folder: string,
  id: string,
  query: string,
  k: number,
): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };

  const meta = readMeta(folder, id);
  const strategy = meta.storeStrategy;

  if (strategy === 'bm25') {
    const results = queryBm25(dir, query, k);
    return { status: 200, body: { results } };
  }

  if (strategy === 'dense') {
    const embMap = await embedChunks(
      [{ id: '__query__', corpusId: id, source: '', text: query, index: -1 }],
      PROXY_BASE_URL,
    );
    const queryVec = embMap.get('__query__');
    if (!queryVec) return { status: 500, body: { error: 'Failed to embed query' } };
    const results = queryDense(dir, queryVec, k);
    return { status: 200, body: { results } };
  }

  if (strategy === 'hybrid') {
    const embMap = await embedChunks(
      [{ id: '__query__', corpusId: id, source: '', text: query, index: -1 }],
      PROXY_BASE_URL,
    );
    const queryVec = embMap.get('__query__');

    // Fetch more candidates for merging, then trim to k
    const bm25Results = queryBm25(dir, query, k * 2);
    const denseResults = queryVec ? queryDense(dir, queryVec, k * 2) : [];

    // Normalize BM25 scores to [0, 1] by dividing by max
    const maxBm25 = bm25Results.reduce((m, r) => Math.max(m, r.score), 0) || 1;
    const normBm25 = new Map(bm25Results.map((r) => [r.chunk.id, r.score / maxBm25]));
    const normDense = new Map(denseResults.map((r) => [r.chunk.id, r.score]));

    // Union of all chunk IDs seen in either result set
    const allIds = new Set([...normBm25.keys(), ...normDense.keys()]);

    // Chunk metadata lookup (prefer dense result for full object)
    const chunkById = new Map<string, QueryResult['chunk']>();
    for (const r of [...bm25Results, ...denseResults]) chunkById.set(r.chunk.id, r.chunk);

    const merged: Array<{ chunk: QueryResult['chunk']; score: number; bm25Score: number; denseScore: number }> = [];
    for (const cid of allIds) {
      const bm25Score = normBm25.get(cid) ?? 0;
      const denseScore = normDense.get(cid) ?? 0;
      merged.push({
        chunk: chunkById.get(cid)!,
        score: Math.max(bm25Score, denseScore), // max-of-normalized fusion
        bm25Score,
        denseScore,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return { status: 200, body: { results: merged.slice(0, k), strategy: 'hybrid' } };
  }

  return { status: 400, body: { error: `Unknown storeStrategy: ${strategy}` } };
}
```

- [ ] **Step 4: Add api-handlers tests for new behavior**

In `src/knowledge/api-handlers.test.ts`, add a `vi.mock` for `embed.js` at the top:

```typescript
import { vi } from 'vitest';

vi.mock('./stages/embed.js', () => ({
  embedChunks: vi.fn().mockResolvedValue(
    new Map([['__query__', new Float32Array([1, 0, 0, 0])]])
  ),
}));
```

Add new test cases:

```typescript
describe('handleCreateCorpus — storeStrategy', () => {
  it('defaults storeStrategy to bm25', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'test' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('bm25');
  });

  it('accepts storeStrategy dense', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'dense-test', storeStrategy: 'dense' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('dense');
  });

  it('accepts storeStrategy hybrid', async () => {
    const result = await handleCreateCorpus(tmpFolder, { name: 'hybrid-test', storeStrategy: 'hybrid' });
    expect(result.status).toBe(201);
    expect((result.body as CorpusMeta).storeStrategy).toBe('hybrid');
  });
});

describe('handleQuery — dense strategy', () => {
  it('calls embedChunks for query and returns results array', async () => {
    const { embedChunks } = await import('./stages/embed.js');
    // Create a dense corpus with a built dense.db (empty index is fine for handler routing test)
    const createResult = await handleCreateCorpus(tmpFolder, { name: 'd', storeStrategy: 'dense' });
    const meta = createResult.body as CorpusMeta;
    // Mark ready so handleQuery doesn't short-circuit
    updateStatus(tmpFolder, meta.id, 'ready');

    const result = await handleQuery(tmpFolder, meta.id, 'hello', 5);
    expect(result.status).toBe(200);
    expect(embedChunks).toHaveBeenCalled();
    expect((result.body as { results: unknown[] }).results).toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 5: Build and test**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test -- api-handlers
```

---

### Task 5: Sources tab UI — Dense + Hybrid preset cards

**Files:**
- Modify: `src/channels/playground/public/tabs/sources.js`

**Success criteria (manual):** Browser shows three strategy cards in the new-corpus form. Clicking each moves the selection border. "Build corpus" sends the chosen strategy. Corpus list cards show a strategy label. Cancel resets the selection to BM25.

- [ ] **Step 1: Replace the new-corpus form HTML**

Find the `<div id="src-new-form" ...>` block inside the `el.innerHTML` template string in `mountSources`. Replace the entire form div:

```html
<div id="src-new-form" style="display:none;border:1px solid var(--border,#ddd);border-radius:6px;padding:1rem;margin-bottom:1rem">
  <label style="display:block;margin-bottom:0.75rem">Corpus name
    <input id="src-corpus-name" type="text" style="display:block;width:100%;margin-top:0.25rem;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit" placeholder="e.g. Lecture 3 notes">
  </label>

  <div style="margin-bottom:0.75rem">
    <div style="font-size:13px;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted,#555)">Retrieval strategy</div>
    <div id="src-strategy-cards" style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <div class="strategy-card strategy-selected" data-strategy="bm25" style="flex:1;min-width:140px;border:2px solid var(--accent,#5b6ee1);border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer">
        <div style="font-weight:600;font-size:13px">BM25 / Quick</div>
        <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">Keyword search. Fast, no API cost.</div>
      </div>
      <div class="strategy-card" data-strategy="dense" style="flex:1;min-width:140px;border:2px solid transparent;border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer;background:var(--bg-subtle,#f5f5f5)">
        <div style="font-weight:600;font-size:13px">Dense</div>
        <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">Semantic embeddings. Requires OpenAI key.</div>
      </div>
      <div class="strategy-card" data-strategy="hybrid" style="flex:1;min-width:140px;border:2px solid transparent;border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer;background:var(--bg-subtle,#f5f5f5)">
        <div style="font-weight:600;font-size:13px">Hybrid</div>
        <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">BM25 + dense. Side-by-side scores.</div>
      </div>
    </div>
    <input id="src-store-strategy" type="hidden" value="bm25">
  </div>

  <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
    <button id="src-create-btn" class="btn btn-primary">Create</button>
    <button id="src-cancel-btn" class="btn">Cancel</button>
  </div>
</div>
```

- [ ] **Step 2: Add strategy card click handler**

After the `el.querySelector('#src-cancel-btn').addEventListener(...)` block, add:

```javascript
el.querySelectorAll('.strategy-card').forEach((card) => {
  card.addEventListener('click', () => {
    el.querySelector('#src-store-strategy').value = card.dataset.strategy;
    el.querySelectorAll('.strategy-card').forEach((c) => {
      c.style.border = '2px solid transparent';
      c.style.background = 'var(--bg-subtle,#f5f5f5)';
    });
    card.style.border = '2px solid var(--accent,#5b6ee1)';
    card.style.background = '';
  });
});
```

- [ ] **Step 3: Pass `storeStrategy` in the create POST**

In the `#src-create-btn` click handler, change the fetch body:

```javascript
body: JSON.stringify({
  name,
  sourceType: 'text',
  storeStrategy: el.querySelector('#src-store-strategy').value || 'bm25',
}),
```

- [ ] **Step 4: Show strategy label in corpus list**

In `renderList()`, add a strategy label to each corpus card:

```javascript
listEl.innerHTML = corpora.map((c) => `
  <div class="corpus-card" data-id="${esc(c.id)}" style="cursor:pointer">
    <span class="corpus-name">${esc(c.name)}</span>
    <span class="corpus-meta">${c.chunkCount ?? 0} chunks</span>
    <span class="corpus-meta" style="font-size:11px;opacity:0.7">${esc(c.storeStrategy ?? 'bm25')}</span>
    <span class="status-badge status-${esc(c.status)}">${esc(c.status)}</span>
    <button class="btn btn-danger" data-del="${esc(c.id)}" title="Delete" style="padding:2px 8px;font-size:12px">&#10005;</button>
  </div>
`).join('');
```

- [ ] **Step 5: Reset strategy picker on cancel**

Replace the `#src-cancel-btn` listener body:

```javascript
el.querySelector('#src-cancel-btn').addEventListener('click', () => {
  el.querySelector('#src-new-form').style.display = 'none';
  el.querySelector('#src-corpus-name').value = '';
  el.querySelector('#src-store-strategy').value = 'bm25';
  const cards = el.querySelectorAll('.strategy-card');
  cards.forEach((c, i) => {
    c.style.border = i === 0 ? '2px solid var(--accent,#5b6ee1)' : '2px solid transparent';
    c.style.background = i === 0 ? '' : 'var(--bg-subtle,#f5f5f5)';
  });
});
```

---

### Task 6: Retrieval tab UI — strategy badge + hybrid side-by-side columns

**Files:**
- Modify: `src/channels/playground/public/tabs/retrieval.js`

**Success criteria (manual):** BM25 corpora render exactly as before. Hybrid corpora show a four-column table (Chunk, BM25, Dense, Fused). A strategy badge appears next to the corpus selector and updates when the selection changes.

- [ ] **Step 1: Add strategy badge to the control row HTML**

In the initial `el.innerHTML` template, find the controls row (`display:flex;align-items:center;gap:0.75rem...`). Add a `<span id="ret-strategy-badge">` after the k-select label:

```html
<span id="ret-strategy-badge" style="font-size:12px;padding:2px 8px;border-radius:10px;background:var(--bg-subtle,#eee);color:var(--text-muted,#555)"></span>
```

- [ ] **Step 2: Add `updateStrategyBadge` helper and wire corpus select change**

After the `const resultsEl = ...` line, add:

```javascript
function updateStrategyBadge() {
  const opt = corpusSelect.options[corpusSelect.selectedIndex];
  const strategy = opt?.dataset?.strategy ?? '';
  const badge = el.querySelector('#ret-strategy-badge');
  if (badge) badge.textContent = strategy ? `strategy: ${strategy}` : '';
}
corpusSelect.addEventListener('change', updateStrategyBadge);
```

- [ ] **Step 3: Update `loadCorpora` to store `storeStrategy` on options**

Replace `loadCorpora`:

```javascript
async function loadCorpora() {
  try {
    const res = await fetch(apiBase, { headers, credentials: 'same-origin' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const ready = (data.corpora ?? []).filter((c) => c.status === 'ready');
    if (!ready.length) {
      corpusSelect.innerHTML = '<option value="">— no ready corpora —</option>';
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No ready corpora available. Build one in the Sources tab first.</p>';
      return;
    }
    corpusSelect.innerHTML = ready.map((c) =>
      `<option value="${esc(c.id)}" data-strategy="${esc(c.storeStrategy ?? 'bm25')}">${esc(c.name)} [${esc(c.storeStrategy ?? 'bm25')}]</option>`
    ).join('');
    updateStrategyBadge();
  } catch {
    corpusSelect.innerHTML = '<option value="">— error loading —</option>';
  }
}
```

- [ ] **Step 4: Update result rendering to branch on strategy**

Inside `search()`, after `const results = data.results ?? [];`, replace the no-results check and the `resultsEl.innerHTML = results.map(...)` block with:

```javascript
const selectedOpt = corpusSelect.options[corpusSelect.selectedIndex];
const strategy = selectedOpt?.dataset?.strategy ?? 'bm25';

if (!results.length) {
  resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No results found.</p>';
  return;
}

if (strategy === 'hybrid') {
  resultsEl.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="text-align:left;border-bottom:2px solid var(--border,#ddd)">
          <th style="padding:6px 8px;width:55%">Chunk</th>
          <th style="padding:6px 8px;width:15%;text-align:right">BM25</th>
          <th style="padding:6px 8px;width:15%;text-align:right">Dense</th>
          <th style="padding:6px 8px;width:15%;text-align:right">Fused</th>
        </tr>
      </thead>
      <tbody>
        ${results.map((r) => {
          const text = String(r.chunk?.text ?? '');
          const truncated = text.length > 300 ? text.slice(0, 300) + '…' : text;
          const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '—');
          return `<tr style="border-bottom:1px solid var(--border,#eee);vertical-align:top">
            <td style="padding:6px 8px;white-space:pre-wrap">${esc(truncated)}<br>
              <span style="font-size:11px;opacity:0.6">${esc(r.chunk?.source ?? '')} &middot; chunk ${esc(String(r.chunk?.index ?? ''))}</span>
            </td>
            <td style="padding:6px 8px;text-align:right">${esc(fmt(r.bm25Score))}</td>
            <td style="padding:6px 8px;text-align:right">${esc(fmt(r.denseScore))}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600">${esc(fmt(r.score))}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
} else {
  // BM25 or dense — both return the same QueryResult[] shape
  resultsEl.innerHTML = results.map((r) => {
    const text = String(r.chunk?.text ?? '');
    const truncated = text.length > 400 ? text.slice(0, 400) + '…' : text;
    const score = typeof r.score === 'number' ? r.score.toFixed(3) : String(r.score ?? '');
    return `
      <div class="result-card">
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem">
          <span class="result-score">score: ${esc(score)}</span>
          <span class="result-source">${esc(r.chunk?.source ?? '')} &middot; chunk ${esc(String(r.chunk?.index ?? ''))}</span>
        </div>
        <div style="font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(truncated)}</div>
      </div>
    `;
  }).join('');
}
```

---

## Final verification

After all six tasks are complete:

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test
```

Expected: clean TypeScript build, all tests pass (embed, store-dense, pipeline, api-handlers, plus all existing tests).

Manual smoke-test checklist:
- [ ] Create a BM25 corpus, ingest, query: existing behavior unchanged
- [ ] Create a Dense corpus: "Build corpus" contacts `localhost:3001/openai/v1/embeddings`; status reaches `ready`; query returns cosine-ranked results
- [ ] Create a Hybrid corpus: after ingest both `bm25.db` and `dense.db` exist under `groups/<folder>/knowledge/corpora/<id>/`; Retrieval tab shows four-column table with BM25 / Dense / Fused columns
- [ ] Strategy badge in Retrieval tab updates correctly when switching between corpora
- [ ] Cancel in Sources form resets strategy selection to BM25
