import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function agentDir(): string {
  return process.env.AGENT_DIR ?? '/workspace/agent';
}

function corporaDir(): string {
  return path.join(agentDir(), 'knowledge', 'corpora');
}

interface CorpusMeta {
  id: string;
  name: string;
  status: string;
}

interface QueryRow {
  id: string;
  corpus_id: string;
  source: string;
  chunk_index: number;
  text: string;
  score: number;
}

interface RankedResult {
  corpusName: string;
  source: string;
  chunkIndex: number;
  score: number;
  text: string;
}

function readMeta(corpusPath: string): CorpusMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(corpusPath, 'meta.json'), 'utf8')) as CorpusMeta;
  } catch {
    return null;
  }
}

function listReadyCorpora(): Array<{ meta: CorpusMeta; dir: string }> {
  const dir = corporaDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const corpusPath = path.join(dir, e.name);
      const meta = readMeta(corpusPath);
      if (!meta || meta.status !== 'ready') return [];
      return [{ meta, dir: corpusPath }];
    });
}

/**
 * Convert a plain multi-word keyword query to FTS5 OR syntax so that chunks
 * matching any of the terms are returned.  Queries that already contain FTS5
 * operators (AND, OR, NOT, quotes, column filters, ^, *) are passed through
 * unchanged — those users know what they're doing.
 */
function normalizeQuery(query: string): string {
  const hasOperators = /\bAND\b|\bOR\b|\bNOT\b|"|'|\*|\^|:/.test(query);
  if (hasOperators) return query;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length <= 1) return query;
  return terms.join(' OR ');
}

function searchCorpus(dir: string, query: string, k: number): QueryRow[] {
  const dbPath = path.join(dir, 'bm25.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, corpus_id, source, chunk_index, text, bm25(chunks) AS score
         FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(normalizeQuery(query), k) as QueryRow[];
  } finally {
    db.close();
  }
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function mkErr(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatResults(results: RankedResult[]): string {
  return results
    .map(
      (r, i) =>
        `[Result ${i + 1}]\nCorpus: ${r.corpusName}\nSource: ${r.source} (chunk ${r.chunkIndex})\nScore: ${r.score.toFixed(4)}\n${r.text}`,
    )
    .join('\n\n---\n\n');
}

export const knowledgeSearch: McpToolDefinition = {
  tool: {
    name: 'knowledge_search',
    description:
      "Search the agent group's knowledge corpora using BM25 full-text search. " +
      'Returns the top-k most relevant chunks ranked by BM25 score. ' +
      'Search all ready corpora by default, or limit to one with corpus_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search query (FTS5 MATCH syntax). Keep it simple — keywords or phrases.' },
        k: { type: 'number', description: 'Maximum number of results to return (default: 5).' },
        corpus_id: { type: 'string', description: 'If given, search only this corpus (by id). Omit to search all ready corpora.' },
      },
      required: ['query'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const query = String(args.query ?? '').trim();
    const k = typeof args.k === 'number' && args.k > 0 ? Math.floor(args.k) : 5;
    const corpusId = typeof args.corpus_id === 'string' ? args.corpus_id.trim() : undefined;

    if (!query) return mkErr('query is required and must be a non-empty string.');

    if (corpusId) {
      const dir = path.join(corporaDir(), corpusId);
      if (!fs.existsSync(dir)) return mkErr(`Corpus "${corpusId}" not found.`);
      const meta = readMeta(dir);
      if (!meta) return mkErr(`Corpus "${corpusId}" has no readable meta.json.`);
      if (meta.status !== 'ready') return mkErr(`Corpus "${corpusId}" is not ready (status: ${meta.status}). Build it in the Sources tab first.`);

      let rows: QueryRow[];
      try {
        rows = searchCorpus(dir, query, k);
      } catch (e) {
        return mkErr(`Invalid search query: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (rows.length === 0) return ok('No relevant chunks found.');
      return ok(formatResults(rows.map((r) => ({ corpusName: meta.name, source: r.source, chunkIndex: r.chunk_index, score: Math.abs(r.score), text: r.text }))));
    }

    const ready = listReadyCorpora();
    if (ready.length === 0) return ok('No ready knowledge corpora found. Build one in the Sources tab.');

    const allResults: RankedResult[] = [];
    let ftsError: string | null = null;

    for (const { meta, dir } of ready) {
      let rows: QueryRow[];
      try {
        rows = searchCorpus(dir, query, k);
      } catch (e) {
        ftsError = e instanceof Error ? e.message : String(e);
        break;
      }
      for (const r of rows) {
        allResults.push({ corpusName: meta.name, source: r.source, chunkIndex: r.chunk_index, score: Math.abs(r.score), text: r.text });
      }
    }

    if (ftsError !== null) return mkErr(`Invalid search query: ${ftsError}`);
    if (allResults.length === 0) return ok('No relevant chunks found.');

    allResults.sort((a, b) => b.score - a.score);
    return ok(formatResults(allResults.slice(0, k)));
  },
};

registerTools([knowledgeSearch]);
