// Dense vector index using better-sqlite3 BLOBs + JS cosine similarity.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Chunk, QueryResult } from '../types.js';

function dbPath(dir: string): string {
  return path.join(dir, 'dense.db');
}

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i]!;
  return new Float32Array(ab);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

function cosine(a: Float32Array, b: Float32Array): number {
  const d = norm(a) * norm(b);
  if (d === 0) return 0;
  return dot(a, b) / d;
}

/**
 * Build (or rebuild) a dense vector index.
 * Chunks not in the embeddings map are silently skipped.
 */
export function buildDenseIndex(corpusDir: string, chunks: Chunk[], embeddings: Map<string, Float32Array>): void {
  const p = dbPath(corpusDir);
  if (fs.existsSync(p)) fs.rmSync(p);

  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE chunk_embeddings (
      chunk_id    TEXT PRIMARY KEY,
      corpus_id   TEXT NOT NULL,
      source      TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text        TEXT NOT NULL,
      embedding   BLOB NOT NULL
    )`,
  );

  const insert = db.prepare(
    'INSERT INTO chunk_embeddings (chunk_id, corpus_id, source, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?, ?)',
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
 * Returns up to k results sorted by descending score.
 */
export function queryDense(corpusDir: string, queryEmbedding: Float32Array, k = 5): QueryResult[] {
  const p = dbPath(corpusDir);
  if (!fs.existsSync(p)) return [];

  const db = new Database(p, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT chunk_id, corpus_id, source, chunk_index, text, embedding FROM chunk_embeddings')
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
