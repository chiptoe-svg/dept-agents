export type CorpusStatus = 'empty' | 'ingesting' | 'ready' | 'error';
export type SourceType = 'text';
export type ChunkStrategy = 'fixed' | 'sentence';
export type StoreStrategy = 'bm25';

export interface CorpusMeta {
  id: string;
  name: string;
  sourceType: SourceType;
  chunkStrategy: ChunkStrategy;
  storeStrategy: StoreStrategy;
  status: CorpusStatus;
  errorMessage?: string;
  chunkCount?: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface Chunk {
  id: string;       // `${corpusId}:${index}`
  corpusId: string;
  source: string;   // filename or URL
  text: string;
  index: number;
}

export interface QueryResult {
  chunk: Chunk;
  score: number;   // BM25 absolute value; higher = more relevant
}
