import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Chunk, QueryResult } from '../types.js';

function dbPath(corpusDir: string): string {
  return path.join(corpusDir, 'bm25.db');
}

/** Build (or rebuild) an FTS5 BM25 index from chunks. Deletes any existing bm25.db first. */
export function buildBm25Index(corpusDir: string, chunks: Chunk[]): void {
  const p = dbPath(corpusDir);
  if (fs.existsSync(p)) fs.rmSync(p);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE VIRTUAL TABLE chunks USING fts5(
    id UNINDEXED,
    corpus_id UNINDEXED,
    source UNINDEXED,
    chunk_index UNINDEXED,
    text,
    tokenize = 'porter unicode61'
  )`);
  const insert = db.prepare(
    'INSERT INTO chunks (id, corpus_id, source, chunk_index, text) VALUES (?, ?, ?, ?, ?)'
  );
  const insertAll = db.transaction((rows: Chunk[]) => {
    for (const c of rows) insert.run(c.id, c.corpusId, c.source, c.index, c.text);
  });
  insertAll(chunks);
  db.close();
}

/** Query BM25 index. Returns results ranked by score (higher = more relevant). */
export function queryBm25(corpusDir: string, query: string, k = 5): QueryResult[] {
  const p = dbPath(corpusDir);
  if (!fs.existsSync(p)) return [];
  const db = new Database(p, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, corpus_id, source, chunk_index, text, bm25(chunks) AS score
         FROM chunks
         WHERE chunks MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(query, k) as Array<{
      id: string;
      corpus_id: string;
      source: string;
      chunk_index: number;
      text: string;
      score: number;
    }>;
    return rows.map((r) => ({
      chunk: {
        id: r.id,
        corpusId: r.corpus_id,
        source: r.source,
        text: r.text,
        index: r.chunk_index,
      },
      score: Math.abs(r.score),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}
