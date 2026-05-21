import fs from 'fs';
import path from 'path';
import { createCorpus, corpusDir, listCorpora, readMeta, deleteCorpus } from './corpus.js';
import { readChunks, runTextPipeline } from './pipeline.js';
import { queryBm25 } from './stages/store-bm25.js';
import { embedChunks } from './stages/embed.js';
import { queryDense } from './stages/store-dense.js';
import type { SourceType, StoreStrategy, QueryResult } from './types.js';

type HandlerResult = { status: number; body: unknown };

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';

export async function handleListCorpora(folder: string): Promise<HandlerResult> {
  return { status: 200, body: { corpora: listCorpora(folder) } };
}

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

export async function handleDeleteCorpus(folder: string, id: string): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  deleteCorpus(folder, id);
  return { status: 204, body: null };
}

export async function handleGetCorpus(folder: string, id: string): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  return { status: 200, body: readMeta(folder, id) };
}

export async function handleUploadSource(
  folder: string,
  id: string,
  filename: string,
  data: Buffer,
): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  const safe = path.basename(filename);
  fs.writeFileSync(path.join(dir, 'raw', safe), data);
  return { status: 200, body: { filename: safe } };
}

export async function handleIngest(folder: string, id: string): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  void runTextPipeline(folder, id);
  return { status: 202, body: { message: 'Ingestion started' } };
}

export async function handleInspect(folder: string, id: string): Promise<HandlerResult> {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  const chunks = readChunks(folder, id);
  const meta = readMeta(folder, id);
  return { status: 200, body: { meta, chunks } };
}

export async function handleQuery(folder: string, id: string, query: string, k: number): Promise<HandlerResult> {
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

    const bm25Results = queryBm25(dir, query, k * 2);
    const denseResults = queryVec ? queryDense(dir, queryVec, k * 2) : [];

    const maxBm25 = bm25Results.reduce((m, r) => Math.max(m, r.score), 0) || 1;
    const normBm25 = new Map(bm25Results.map((r) => [r.chunk.id, r.score / maxBm25]));
    const normDense = new Map(denseResults.map((r) => [r.chunk.id, r.score]));

    const allIds = new Set([...normBm25.keys(), ...normDense.keys()]);
    const chunkById = new Map<string, QueryResult['chunk']>();
    for (const r of [...bm25Results, ...denseResults]) chunkById.set(r.chunk.id, r.chunk);

    const merged: Array<{
      chunk: QueryResult['chunk'];
      score: number;
      bm25Score: number;
      denseScore: number;
    }> = [];
    for (const cid of allIds) {
      const bm25Score = normBm25.get(cid) ?? 0;
      const denseScore = normDense.get(cid) ?? 0;
      merged.push({
        chunk: chunkById.get(cid)!,
        score: Math.max(bm25Score, denseScore),
        bm25Score,
        denseScore,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return { status: 200, body: { results: merged.slice(0, k), strategy: 'hybrid' } };
  }

  return { status: 400, body: { error: `Unknown storeStrategy: ${strategy}` } };
}
