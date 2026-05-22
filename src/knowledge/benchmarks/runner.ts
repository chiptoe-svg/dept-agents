import fs from 'fs';
import path from 'path';
import { queryBm25 } from '../stages/store-bm25.js';
import { queryDense } from '../stages/store-dense.js';
import { embedChunks } from '../stages/embed.js';
import type { BenchmarkMeta, BenchmarkRunResult, QueryBenchmarkResult, StrategyMetrics } from './types.js';

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';

function isRelevant(text: string, relevant: string[]): boolean {
  if (relevant.length === 0) return false;
  const lower = text.toLowerCase();
  return relevant.some((snippet) => lower.includes(snippet.toLowerCase()));
}

function findHitRank(chunks: Array<{ text: string }>, relevant: string[]): number | null {
  if (relevant.length === 0) return null;
  for (let i = 0; i < chunks.length; i++) {
    if (isRelevant(chunks[i]!.text, relevant)) return i + 1;
  }
  return null;
}

function computeMetrics(hitRanks: Array<number | null>, k: number): StrategyMetrics {
  const total = hitRanks.length;
  if (total === 0) return { mrr: 0, hitAt1: 0, hitAt3: 0, hitAtK: 0 };
  return {
    mrr: hitRanks.reduce<number>((s, r) => s + (r !== null ? 1 / r : 0), 0) / total,
    hitAt1: hitRanks.filter((r) => r !== null && r <= 1).length / total,
    hitAt3: hitRanks.filter((r) => r !== null && r <= 3).length / total,
    hitAtK: hitRanks.filter((r) => r !== null && r <= k).length / total,
  };
}

export async function runBenchmark(corpusDir: string, meta: BenchmarkMeta, k: number): Promise<BenchmarkRunResult> {
  const hasBm25 = fs.existsSync(path.join(corpusDir, 'bm25.db'));
  const hasDense = fs.existsSync(path.join(corpusDir, 'dense.db'));

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
    const hitRanks = queriesRun.filter((q) => q.relevant.length > 0).map((q) => q.strategies.bm25?.hitRank ?? null);
    strategyMetrics.bm25 = computeMetrics(hitRanks, k);
  }

  if (hasDense) {
    const hitRanks = queriesRun.filter((q) => q.relevant.length > 0).map((q) => q.strategies.dense?.hitRank ?? null);
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
