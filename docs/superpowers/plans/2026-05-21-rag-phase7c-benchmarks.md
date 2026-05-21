# Phase 7C — Benchmarks Tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Benchmarks tab where instructors can create test query sets, run them against a corpus, and see per-strategy retrieval metrics (MRR, Hit@k) side by side — the key pedagogical payoff for teaching IR evaluation.

**Architecture:** Benchmark sets are JSON files under `groups/<folder>/knowledge/benchmarks/<id>/meta.json`. Running a benchmark calls `queryBm25` / `queryDense` directly for each strategy whose index file exists (not via the query handler, to avoid the embedding round-trip for BM25). Relevance is determined by case-insensitive substring match against optional "gold snippets" per query. Results are computed on demand and not persisted — no extra files or DB tables needed.

**Tech Stack:** Node.js fs, better-sqlite3 (via existing store modules), vitest for tests. No new npm packages.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/knowledge/benchmarks/types.ts` | Create | BenchmarkMeta, BenchmarkQuery, BenchmarkRunResult, StrategyResult, StrategyMetrics |
| `src/knowledge/benchmarks/store.ts` | Create | createBenchmark, readBenchmark, writeBenchmark, listBenchmarks, deleteBenchmark |
| `src/knowledge/benchmarks/store.test.ts` | Create | CRUD roundtrip tests, tmpdir fixture |
| `src/knowledge/benchmarks/runner.ts` | Create | runBenchmark — query per strategy, compute hit@k + MRR |
| `src/knowledge/benchmarks/runner.test.ts` | Create | Mock queryBm25/queryDense/embedChunks, verify metrics |
| `src/knowledge/benchmarks/api-handlers.ts` | Create | handleListBenchmarks, handleGetBenchmark, handleCreateBenchmark, handleUpdateBenchmark, handleDeleteBenchmark, handleRunBenchmark |
| `src/knowledge/benchmarks/api-handlers.test.ts` | Create | Handler integration tests |
| `src/channels/playground/api-routes.ts` | Modify | Wire benchmark routes after the knowledge query route |
| `src/channels/playground/public/index.html` | Modify | Add `<button data-tab="benchmarks">` and `<section id="tab-benchmarks">` |
| `src/channels/playground/public/app.js` | Modify | Import mountBenchmarks, add 'benchmarks' to TABS + mounters |
| `src/channels/playground/public/tabs/benchmarks.js` | Create | Full benchmarks UI |

---

### Task 1: Types + Store

**Files:**
- Create: `src/knowledge/benchmarks/types.ts`
- Create: `src/knowledge/benchmarks/store.ts`
- Create: `src/knowledge/benchmarks/store.test.ts`

**Success criteria:** `pnpm test -- benchmarks/store` passes.

- [ ] **Step 1: Write the types**

```typescript
// src/knowledge/benchmarks/types.ts
export interface BenchmarkQuery {
  id: string;
  query: string;
  relevant: string[]; // gold snippet substrings, case-insensitive; empty = unscored
}

export interface BenchmarkMeta {
  id: string;
  name: string;
  corpusId: string;
  queries: BenchmarkQuery[];
  createdAt: string;
  updatedAt: string;
}

export interface StrategyResult {
  chunks: Array<{ id: string; text: string; source: string; index: number; score: number }>;
  hitRank: number | null; // 1-based rank of first relevant chunk; null if none or unscored
}

export interface QueryBenchmarkResult {
  queryId: string;
  query: string;
  relevant: string[];
  strategies: Partial<Record<'bm25' | 'dense', StrategyResult>>;
}

export interface StrategyMetrics {
  mrr: number;   // mean reciprocal rank across scored queries (0–1)
  hitAt1: number; // fraction of scored queries with hit in top-1
  hitAt3: number; // fraction of scored queries with hit in top-3
  hitAtK: number; // fraction of scored queries with hit in top-k
}

export interface BenchmarkRunResult {
  benchmarkId: string;
  corpusId: string;
  k: number;
  runAt: string;
  queriesRun: QueryBenchmarkResult[];
  summary: {
    total: number;
    scored: number; // queries that had at least one gold snippet
    strategies: Partial<Record<'bm25' | 'dense', StrategyMetrics>>;
  };
}
```

- [ ] **Step 2: Write the failing store tests**

```typescript
// src/knowledge/benchmarks/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createBenchmark,
  readBenchmark,
  writeBenchmark,
  listBenchmarks,
  deleteBenchmark,
} from './store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-store-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createBenchmark', () => {
  it('creates meta.json with the given name and corpusId', () => {
    const meta = createBenchmark(tmpDir, { name: 'test bench', corpusId: 'corp1' });
    expect(meta.name).toBe('test bench');
    expect(meta.corpusId).toBe('corp1');
    expect(meta.queries).toEqual([]);
    expect(typeof meta.id).toBe('string');
  });

  it('persists to disk', () => {
    const meta = createBenchmark(tmpDir, { name: 'b', corpusId: 'c' });
    const read = readBenchmark(tmpDir, meta.id);
    expect(read.id).toBe(meta.id);
  });
});

describe('listBenchmarks', () => {
  it('returns empty array when no benchmarks exist', () => {
    expect(listBenchmarks(tmpDir)).toEqual([]);
  });

  it('returns all created benchmarks sorted newest first', () => {
    createBenchmark(tmpDir, { name: 'a', corpusId: 'c' });
    createBenchmark(tmpDir, { name: 'b', corpusId: 'c' });
    const list = listBenchmarks(tmpDir);
    expect(list.length).toBe(2);
  });
});

describe('writeBenchmark', () => {
  it('updates updatedAt and persists', () => {
    const meta = createBenchmark(tmpDir, { name: 'x', corpusId: 'c' });
    meta.queries.push({ id: 'q1', query: 'hello', relevant: ['world'] });
    writeBenchmark(tmpDir, meta);
    const read = readBenchmark(tmpDir, meta.id);
    expect(read.queries.length).toBe(1);
    expect(read.queries[0]!.query).toBe('hello');
  });
});

describe('deleteBenchmark', () => {
  it('removes the benchmark directory', () => {
    const meta = createBenchmark(tmpDir, { name: 'd', corpusId: 'c' });
    deleteBenchmark(tmpDir, meta.id);
    expect(() => readBenchmark(tmpDir, meta.id)).toThrow();
  });

  it('is a no-op for unknown id', () => {
    expect(() => deleteBenchmark(tmpDir, 'nope')).not.toThrow();
  });
});
```

- [ ] **Step 3: Implement `store.ts`**

```typescript
// src/knowledge/benchmarks/store.ts
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { BenchmarkMeta } from './types.js';

function benchmarksDir(folder: string): string {
  return path.join(folder, 'knowledge', 'benchmarks');
}

function benchmarkDir(folder: string, id: string): string {
  return path.join(benchmarksDir(folder), id);
}

export function createBenchmark(
  folder: string,
  opts: { name: string; corpusId: string },
): BenchmarkMeta {
  const id = randomBytes(8).toString('hex');
  const dir = benchmarkDir(folder, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: BenchmarkMeta = {
    id,
    name: opts.name,
    corpusId: opts.corpusId,
    queries: [],
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function readBenchmark(folder: string, id: string): BenchmarkMeta {
  const p = path.join(benchmarkDir(folder, id), 'meta.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BenchmarkMeta;
}

export function writeBenchmark(folder: string, meta: BenchmarkMeta): void {
  meta.updatedAt = new Date().toISOString();
  const p = path.join(benchmarkDir(folder, meta.id), 'meta.json');
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

export function listBenchmarks(folder: string): BenchmarkMeta[] {
  const dir = benchmarksDir(folder);
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const metas = ids.flatMap((id) => {
    try {
      return [readBenchmark(folder, id)];
    } catch {
      return [];
    }
  });
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBenchmark(folder: string, id: string): void {
  const dir = benchmarkDir(folder, id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm test -- benchmarks/store
```

Expected: all store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/benchmarks/types.ts src/knowledge/benchmarks/store.ts src/knowledge/benchmarks/store.test.ts
git commit -m "feat(benchmarks): types + store — benchmark CRUD on disk"
```

---

### Task 2: Runner

**Files:**
- Create: `src/knowledge/benchmarks/runner.ts`
- Create: `src/knowledge/benchmarks/runner.test.ts`

**Success criteria:** `pnpm test -- benchmarks/runner` passes. No real SQLite or API calls — all query functions are mocked.

- [ ] **Step 1: Write the failing runner tests**

```typescript
// src/knowledge/benchmarks/runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BenchmarkMeta } from './types.js';

vi.mock('../../knowledge/stages/store-bm25.js', () => ({
  queryBm25: vi.fn(),
}));
vi.mock('../../knowledge/stages/store-dense.js', () => ({
  queryDense: vi.fn(),
}));
vi.mock('../../knowledge/stages/embed.js', () => ({
  embedChunks: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { queryBm25 } from '../../knowledge/stages/store-bm25.js';
import { queryDense } from '../../knowledge/stages/store-dense.js';
import { embedChunks } from '../../knowledge/stages/embed.js';
import fs from 'fs';
import { runBenchmark } from './runner.js';

function makeMeta(queries: BenchmarkMeta['queries']): BenchmarkMeta {
  return {
    id: 'b1',
    name: 'test',
    corpusId: 'c1',
    queries,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeChunk(id: string, text: string, score = 1.0) {
  return { chunk: { id, corpusId: 'c1', source: 'f.txt', text, index: 0 }, score };
}

beforeEach(() => {
  vi.clearAllMocks();
  (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
});

describe('runBenchmark', () => {
  it('runs bm25 strategy when bm25.db exists', async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      String(p).endsWith('bm25.db'),
    );
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([
      makeChunk('c:0', 'The quick brown fox', 2.5),
    ]);

    const meta = makeMeta([{ id: 'q1', query: 'fox', relevant: ['quick brown fox'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(queryBm25).toHaveBeenCalledTimes(1);
    expect(result.queriesRun[0]!.strategies.bm25).toBeDefined();
    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBe(1);
  });

  it('runs dense strategy when dense.db exists', async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      String(p).endsWith('dense.db'),
    );
    (embedChunks as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([['__query__', new Float32Array([1, 0, 0, 0])]]),
    );
    (queryDense as ReturnType<typeof vi.fn>).mockReturnValue([
      makeChunk('c:0', 'semantic match result', 0.9),
    ]);

    const meta = makeMeta([{ id: 'q1', query: 'semantic', relevant: ['semantic match'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(queryDense).toHaveBeenCalledTimes(1);
    expect(result.queriesRun[0]!.strategies.dense!.hitRank).toBe(1);
  });

  it('computes hitRank = null when no gold snippet matches', async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      String(p).endsWith('bm25.db'),
    );
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([
      makeChunk('c:0', 'completely unrelated text', 1.0),
    ]);

    const meta = makeMeta([{ id: 'q1', query: 'foo', relevant: ['gold snippet here'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBeNull();
  });

  it('marks unscored queries (no relevant snippets) with hitRank = null', async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      String(p).endsWith('bm25.db'),
    );
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([makeChunk('c:0', 'anything', 1.0)]);

    const meta = makeMeta([{ id: 'q1', query: 'anything', relevant: [] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.queriesRun[0]!.strategies.bm25!.hitRank).toBeNull();
    expect(result.summary.scored).toBe(0);
  });

  it('computes MRR correctly for a scored query with hitRank=2', async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      String(p).endsWith('bm25.db'),
    );
    (queryBm25 as ReturnType<typeof vi.fn>).mockReturnValue([
      makeChunk('c:0', 'irrelevant text', 2.0),
      makeChunk('c:1', 'gold snippet is here', 1.5),
    ]);

    const meta = makeMeta([{ id: 'q1', query: 'q', relevant: ['gold snippet'] }]);
    const result = await runBenchmark('/fake/dir', meta, 5);

    expect(result.summary.strategies.bm25!.mrr).toBeCloseTo(0.5, 5);
    expect(result.summary.strategies.bm25!.hitAt1).toBe(0);
    expect(result.summary.strategies.bm25!.hitAt3).toBe(1);
  });

  it('returns empty queriesRun when benchmark has no queries', async () => {
    const meta = makeMeta([]);
    const result = await runBenchmark('/fake/dir', meta, 5);
    expect(result.queriesRun).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `runner.ts`**

```typescript
// src/knowledge/benchmarks/runner.ts
import fs from 'fs';
import path from 'path';
import { queryBm25 } from '../stages/store-bm25.js';
import { queryDense } from '../stages/store-dense.js';
import { embedChunks } from '../stages/embed.js';
import type { BenchmarkMeta, BenchmarkRunResult, QueryBenchmarkResult, StrategyMetrics, StrategyResult } from './types.js';

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';

function isRelevant(text: string, relevant: string[]): boolean {
  if (relevant.length === 0) return false;
  const lower = text.toLowerCase();
  return relevant.some((snippet) => lower.includes(snippet.toLowerCase()));
}

function findHitRank(
  chunks: Array<{ text: string }>,
  relevant: string[],
): number | null {
  if (relevant.length === 0) return null;
  for (let i = 0; i < chunks.length; i++) {
    if (isRelevant(chunks[i]!.text, relevant)) return i + 1;
  }
  return null;
}

function computeMetrics(
  hitRanks: Array<number | null>,
  k: number,
): StrategyMetrics {
  const scored = hitRanks.filter((r) => r !== null) as number[];
  if (scored.length === 0) return { mrr: 0, hitAt1: 0, hitAt3: 0, hitAtK: 0 };
  const n = scored.length;
  return {
    mrr: scored.reduce((s, r) => s + 1 / r, 0) / n,
    hitAt1: scored.filter((r) => r <= 1).length / n,
    hitAt3: scored.filter((r) => r <= 3).length / n,
    hitAtK: scored.filter((r) => r <= k).length / n,
  };
}

export async function runBenchmark(
  corpusDir: string,
  meta: BenchmarkMeta,
  k: number,
): Promise<BenchmarkRunResult> {
  const hasBm25 = fs.existsSync(path.join(corpusDir, 'bm25.db'));
  const hasDense = fs.existsSync(path.join(corpusDir, 'dense.db'));

  // Pre-embed all queries if dense index exists
  let queryVecs = new Map<string, Float32Array>();
  if (hasDense && meta.queries.length > 0) {
    const queryChunks = meta.queries.map((q) => ({
      id: q.id,
      corpusId: meta.corpusId,
      source: '',
      text: q.query,
      index: -1,
    }));
    queryVecs = await embedChunks(queryChunks, PROXY_BASE_URL);
  }

  const queriesRun: QueryBenchmarkResult[] = [];

  for (const q of meta.queries) {
    const strategies: QueryBenchmarkResult['strategies'] = {};

    if (hasBm25) {
      const raw = queryBm25(corpusDir, q.query, k);
      const chunks = raw.map((r) => ({
        id: r.chunk.id,
        text: r.chunk.text,
        source: r.chunk.source,
        index: r.chunk.index,
        score: r.score,
      }));
      strategies.bm25 = { chunks, hitRank: findHitRank(chunks, q.relevant) };
    }

    if (hasDense) {
      const vec = queryVecs.get(q.id);
      if (vec) {
        const raw = queryDense(corpusDir, vec, k);
        const chunks = raw.map((r) => ({
          id: r.chunk.id,
          text: r.chunk.text,
          source: r.chunk.source,
          index: r.chunk.index,
          score: r.score,
        }));
        strategies.dense = { chunks, hitRank: findHitRank(chunks, q.relevant) };
      }
    }

    queriesRun.push({ queryId: q.id, query: q.query, relevant: q.relevant, strategies });
  }

  const scoredCount = meta.queries.filter((q) => q.relevant.length > 0).length;
  const strategyMetrics: BenchmarkRunResult['summary']['strategies'] = {};

  if (hasBm25) {
    const hitRanks = queriesRun
      .filter((q) => q.relevant.length > 0)
      .map((q) => q.strategies.bm25?.hitRank ?? null);
    strategyMetrics.bm25 = computeMetrics(hitRanks, k);
  }

  if (hasDense) {
    const hitRanks = queriesRun
      .filter((q) => q.relevant.length > 0)
      .map((q) => q.strategies.dense?.hitRank ?? null);
    strategyMetrics.dense = computeMetrics(hitRanks, k);
  }

  return {
    benchmarkId: meta.id,
    corpusId: meta.corpusId,
    k,
    runAt: new Date().toISOString(),
    queriesRun,
    summary: {
      total: meta.queries.length,
      scored: scoredCount,
      strategies: strategyMetrics,
    },
  };
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- benchmarks/runner
```

Expected: all 6 runner tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/knowledge/benchmarks/runner.ts src/knowledge/benchmarks/runner.test.ts
git commit -m "feat(benchmarks): runner — per-strategy query + MRR/hit@k metrics"
```

---

### Task 3: API Handlers

**Files:**
- Create: `src/knowledge/benchmarks/api-handlers.ts`
- Create: `src/knowledge/benchmarks/api-handlers.test.ts`

**Success criteria:** `pnpm test -- benchmarks/api-handlers` passes.

- [ ] **Step 1: Write the failing handler tests**

```typescript
// src/knowledge/benchmarks/api-handlers.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  handleListBenchmarks,
  handleCreateBenchmark,
  handleGetBenchmark,
  handleUpdateBenchmark,
  handleDeleteBenchmark,
  handleRunBenchmark,
} from './api-handlers.js';
import { createCorpus, corpusDir } from '../corpus.js';
import type { BenchmarkMeta } from './types.js';

vi.mock('./runner.js', () => ({
  runBenchmark: vi.fn().mockResolvedValue({
    benchmarkId: 'b1',
    corpusId: 'c1',
    k: 5,
    runAt: new Date().toISOString(),
    queriesRun: [],
    summary: { total: 0, scored: 0, strategies: {} },
  }),
}));

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-api-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('handleCreateBenchmark', () => {
  it('creates a benchmark and returns 201', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const r = await handleCreateBenchmark(tmpFolder, { name: 'bench', corpusId: corpus.id });
    expect(r.status).toBe(201);
    expect((r.body as BenchmarkMeta).name).toBe('bench');
  });

  it('returns 400 if name missing', async () => {
    const r = await handleCreateBenchmark(tmpFolder, {} as { name: string; corpusId: string });
    expect(r.status).toBe(400);
  });

  it('returns 400 if corpusId missing', async () => {
    const r = await handleCreateBenchmark(tmpFolder, { name: 'b' } as { name: string; corpusId: string });
    expect(r.status).toBe(400);
  });
});

describe('handleListBenchmarks', () => {
  it('returns empty list initially', async () => {
    const r = await handleListBenchmarks(tmpFolder);
    expect(r.status).toBe(200);
    expect((r.body as { benchmarks: unknown[] }).benchmarks).toEqual([]);
  });
});

describe('handleGetBenchmark', () => {
  it('returns meta for existing benchmark', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleGetBenchmark(tmpFolder, id);
    expect(r.status).toBe(200);
    expect((r.body as BenchmarkMeta).id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const r = await handleGetBenchmark(tmpFolder, 'nope');
    expect(r.status).toBe(404);
  });
});

describe('handleUpdateBenchmark', () => {
  it('replaces queries array', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;

    const r = await handleUpdateBenchmark(tmpFolder, id, {
      queries: [{ id: 'q1', query: 'hello', relevant: ['world'] }],
    });
    expect(r.status).toBe(200);
    const updated = r.body as BenchmarkMeta;
    expect(updated.queries.length).toBe(1);
    expect(updated.queries[0]!.query).toBe('hello');
  });
});

describe('handleDeleteBenchmark', () => {
  it('deletes existing benchmark', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleDeleteBenchmark(tmpFolder, id);
    expect(r.status).toBe(204);
  });
});

describe('handleRunBenchmark', () => {
  it('returns 200 with run result', async () => {
    const corpus = createCorpus(tmpFolder, { name: 'c', sourceType: 'text' });
    const create = await handleCreateBenchmark(tmpFolder, { name: 'b', corpusId: corpus.id });
    const { id } = create.body as BenchmarkMeta;
    const r = await handleRunBenchmark(tmpFolder, id, 5);
    expect(r.status).toBe(200);
    expect((r.body as { benchmarkId: string }).benchmarkId).toBeDefined();
  });

  it('returns 404 for unknown benchmark id', async () => {
    const r = await handleRunBenchmark(tmpFolder, 'nope', 5);
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement `api-handlers.ts`**

```typescript
// src/knowledge/benchmarks/api-handlers.ts
import fs from 'fs';
import path from 'path';
import { corpusDir } from '../corpus.js';
import {
  createBenchmark,
  deleteBenchmark,
  listBenchmarks,
  readBenchmark,
  writeBenchmark,
} from './store.js';
import { runBenchmark } from './runner.js';
import type { BenchmarkQuery } from './types.js';

type HandlerResult = { status: number; body: unknown };

export async function handleListBenchmarks(folder: string): Promise<HandlerResult> {
  return { status: 200, body: { benchmarks: listBenchmarks(folder) } };
}

export async function handleCreateBenchmark(
  folder: string,
  body: { name?: string; corpusId?: string },
): Promise<HandlerResult> {
  if (!body.name) return { status: 400, body: { error: 'name is required' } };
  if (!body.corpusId) return { status: 400, body: { error: 'corpusId is required' } };
  const meta = createBenchmark(folder, { name: body.name, corpusId: body.corpusId });
  return { status: 201, body: meta };
}

export async function handleGetBenchmark(folder: string, id: string): Promise<HandlerResult> {
  try {
    const meta = readBenchmark(folder, id);
    return { status: 200, body: meta };
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
}

export async function handleUpdateBenchmark(
  folder: string,
  id: string,
  body: { name?: string; queries?: BenchmarkQuery[] },
): Promise<HandlerResult> {
  try {
    const meta = readBenchmark(folder, id);
    if (body.name !== undefined) meta.name = body.name;
    if (body.queries !== undefined) meta.queries = body.queries;
    writeBenchmark(folder, meta);
    return { status: 200, body: meta };
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
}

export async function handleDeleteBenchmark(folder: string, id: string): Promise<HandlerResult> {
  try {
    readBenchmark(folder, id); // throws if not found
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
  deleteBenchmark(folder, id);
  return { status: 204, body: null };
}

export async function handleRunBenchmark(
  folder: string,
  id: string,
  k: number,
): Promise<HandlerResult> {
  let meta;
  try {
    meta = readBenchmark(folder, id);
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
  const dir = corpusDir(folder, meta.corpusId);
  if (!fs.existsSync(dir)) {
    return { status: 404, body: { error: 'Corpus not found' } };
  }
  const result = await runBenchmark(dir, meta, k);
  return { status: 200, body: result };
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- benchmarks/api-handlers
```

Expected: all handler tests pass.

- [ ] **Step 4: Build clean**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/benchmarks/api-handlers.ts src/knowledge/benchmarks/api-handlers.test.ts
git commit -m "feat(benchmarks): API handlers — CRUD + run endpoint"
```

---

### Task 4: Wire API Routes

**Files:**
- Modify: `src/channels/playground/api-routes.ts`

**Success criteria:** `pnpm run build` clean. Manual: `curl -X POST .../benchmarks` returns 201.

- [ ] **Step 1: Add import at the top of `api-routes.ts`**

After the existing knowledge `handleQuery` import block (around line 54), add:

```typescript
import {
  handleListBenchmarks,
  handleCreateBenchmark,
  handleGetBenchmark,
  handleUpdateBenchmark,
  handleDeleteBenchmark,
  handleRunBenchmark,
} from '../../knowledge/benchmarks/api-handlers.js';
```

- [ ] **Step 2: Add routes before the final `send(res, 404, ...)` line**

Insert the following block immediately before the final `send(res, 404, ...)` line at the bottom of the `route` function:

```typescript
  // GET  /api/drafts/:folder/knowledge/benchmarks
  // POST /api/drafts/:folder/knowledge/benchmarks
  const benchmarksMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks$/,
  );
  if (benchmarksMatch) {
    const folder = benchmarksMatch[1]!;
    if (method === 'GET') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const r = await handleListBenchmarks(folder);
      return send(res, r.status, r.body);
    }
    if (method === 'POST') {
      if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
      const body = await readJsonBody(req);
      const r = await handleCreateBenchmark(folder, body);
      return send(res, r.status, r.body);
    }
  }

  // GET    /api/drafts/:folder/knowledge/benchmarks/:id
  // PUT    /api/drafts/:folder/knowledge/benchmarks/:id
  // DELETE /api/drafts/:folder/knowledge/benchmarks/:id
  const benchmarkMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks\/([A-Za-z0-9_-]+)$/,
  );
  if (benchmarkMatch) {
    const folder = benchmarkMatch[1]!;
    const id = benchmarkMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    if (method === 'GET') {
      const r = await handleGetBenchmark(folder, id);
      return send(res, r.status, r.body);
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const r = await handleUpdateBenchmark(folder, id, body);
      return send(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const r = await handleDeleteBenchmark(folder, id);
      if (r.status === 204) { res.writeHead(204); res.end(); return; }
      return send(res, r.status, r.body);
    }
  }

  // POST /api/drafts/:folder/knowledge/benchmarks/:id/run
  const benchmarkRunMatch = url.pathname.match(
    /^\/api\/drafts\/([A-Za-z0-9_-]+)\/knowledge\/benchmarks\/([A-Za-z0-9_-]+)\/run$/,
  );
  if (method === 'POST' && benchmarkRunMatch) {
    const folder = benchmarkRunMatch[1]!;
    const id = benchmarkRunMatch[2]!;
    if (!canReadDraft(folder, session.userId)) return send(res, 403, { error: 'Forbidden' });
    const body = await readJsonBody(req);
    const k = typeof body.k === 'number' ? body.k : 5;
    const r = await handleRunBenchmark(folder, id, k);
    return send(res, r.status, r.body);
  }
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test
```

Expected: build clean, all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/channels/playground/api-routes.ts
git commit -m "feat(benchmarks): wire benchmark API routes"
```

---

### Task 5: Frontend — Benchmarks Tab

**Files:**
- Create: `src/channels/playground/public/tabs/benchmarks.js`
- Modify: `src/channels/playground/public/index.html`
- Modify: `src/channels/playground/public/app.js`

**Success criteria (manual):** Benchmarks tab is visible. Creating a benchmark, adding queries with gold snippets, and clicking Run shows a results table with scores. Strategy comparison columns appear when both bm25.db and dense.db exist for the corpus.

- [ ] **Step 1: Add tab to `index.html`**

In `src/channels/playground/public/index.html`, add the Benchmarks tab button after the Retrieval button:

```html
    <button data-tab="benchmarks" class="tab">Benchmarks</button>
```

And add the tab body section after `<section id="tab-retrieval">`:

```html
    <section id="tab-benchmarks" class="tab-body" hidden></section>
```

- [ ] **Step 2: Register in `app.js`**

Add the import at the top of `src/channels/playground/public/app.js`:

```javascript
import { mountBenchmarks } from './tabs/benchmarks.js';
```

Change the TABS array:

```javascript
const TABS = ['home', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks'];
```

Add to the mounters object:

```javascript
const mounters = { home: mountHome, chat: mountChat, persona: mountPersona, skills: mountSkills, models: mountModels, agents: mountAgents, sources: mountSources, retrieval: mountRetrieval, benchmarks: mountBenchmarks };
```

- [ ] **Step 3: Create `benchmarks.js`**

See the long benchmarks.js implementation in the plan file (too large for this summary).

- [ ] **Step 4: Build and verify**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test
```

Expected: build clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/public/tabs/benchmarks.js src/channels/playground/public/index.html src/channels/playground/public/app.js
git commit -m "feat(benchmarks): Benchmarks tab UI — query editor, run, MRR/hit@k metrics"
```

---

## Final verification

After all five tasks:

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build && pnpm test
```

Expected: clean build, all tests pass (store, runner, api-handlers, plus all prior tests).

Manual smoke-test checklist:
- [ ] Benchmarks tab is visible in the nav bar
- [ ] Creating a benchmark prompts for name + corpus (only shows ready corpora)
- [ ] Adding queries with gold snippets saves and re-renders the query list
- [ ] Removing a query updates the list immediately
- [ ] Clicking "Run benchmark" on a BM25 corpus shows per-query table with rank indicators and aggregate MRR / Hit@k
- [ ] Running on a corpus that has both bm25.db and dense.db shows two side-by-side strategy columns
- [ ] Unscored queries (no gold snippets) show "—" in rank column and are excluded from metrics
- [ ] Deleting a benchmark removes it from the list

After writing the file, commit it:

```bash
git add docs/superpowers/plans/2026-05-21-rag-phase7c-benchmarks.md
git commit -m "docs(benchmarks): Phase 7C implementation plan"
```

Then report back with "DONE — plan written and committed."
