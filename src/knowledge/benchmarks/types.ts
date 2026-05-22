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
  mrr: number;
  hitAt1: number;
  hitAt3: number;
  hitAtK: number;
}

export interface BenchmarkRunResult {
  benchmarkId: string;
  corpusId: string;
  k: number;
  runAt: string;
  queriesRun: QueryBenchmarkResult[];
  summary: {
    total: number;
    scored: number;
    strategies: Partial<Record<'bm25' | 'dense', StrategyMetrics>>;
  };
}
