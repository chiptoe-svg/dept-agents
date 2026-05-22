import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { knowledgeSearch } from './knowledge.js';

let tmpDir: string;
let savedAgentDir: string | undefined;

function corporaDir(): string {
  return path.join(tmpDir, 'knowledge', 'corpora');
}

function makeCorpus(
  id: string,
  name: string,
  status: string,
  chunks: Array<{ id: string; source: string; chunk_index: number; text: string }>,
): void {
  const dir = path.join(corporaDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, name, status, sourceType: 'text', chunkStrategy: 'sentence', storeStrategy: 'bm25', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (chunks.length > 0) {
    const dbPath = path.join(dir, 'bm25.db');
    const db = new Database(dbPath);
    db.run(`CREATE VIRTUAL TABLE chunks USING fts5(
      id UNINDEXED, corpus_id UNINDEXED, source UNINDEXED, chunk_index UNINDEXED, text,
      tokenize = 'porter unicode61'
    )`);
    const insert = db.prepare('INSERT INTO chunks (id, corpus_id, source, chunk_index, text) VALUES ($id, $corpus_id, $source, $chunk_index, $text)');
    for (const c of chunks) {
      insert.run({ $id: c.id, $corpus_id: id, $source: c.source, $chunk_index: c.chunk_index, $text: c.text });
    }
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
  savedAgentDir = process.env.AGENT_DIR;
  process.env.AGENT_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedAgentDir === undefined) delete process.env.AGENT_DIR;
  else process.env.AGENT_DIR = savedAgentDir;
});

describe('no corpora', () => {
  test('helpful message when corpora dir does not exist', async () => {
    const result = await knowledgeSearch.handler({ query: 'anything' });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No ready knowledge corpora found');
    expect(text).toContain('Sources tab');
  });

  test('helpful message when all corpora are non-ready', async () => {
    makeCorpus('c1', 'Draft', 'empty', []);
    makeCorpus('c2', 'Ingesting', 'ingesting', []);
    const result = await knowledgeSearch.handler({ query: 'anything' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No ready knowledge corpora found');
  });
});

describe('single ready corpus', () => {
  beforeEach(() => {
    makeCorpus('corpus-a', 'Biology Notes', 'ready', [
      { id: 'corpus-a:0', source: 'ch1.txt', chunk_index: 0, text: 'Mitochondria are the powerhouse of the cell.' },
      { id: 'corpus-a:1', source: 'ch1.txt', chunk_index: 1, text: 'The nucleus contains the genetic material DNA.' },
      { id: 'corpus-a:2', source: 'ch2.txt', chunk_index: 0, text: 'Photosynthesis occurs in chloroplasts using sunlight.' },
    ]);
  });

  test('returns ranked results for matching query', async () => {
    const result = await knowledgeSearch.handler({ query: 'mitochondria' });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Biology Notes');
    expect(text).toContain('Mitochondria');
    expect(text).toContain('ch1.txt');
  });

  test('returns no-results message for non-matching query', async () => {
    const result = await knowledgeSearch.handler({ query: 'quantum entanglement' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No relevant chunks found');
  });

  test('respects k parameter', async () => {
    const result = await knowledgeSearch.handler({ query: 'the', k: 1 });
    const text = (result.content[0] as { text: string }).text;
    const matches = text.match(/\[Result \d+\]/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

describe('corpus_id filter', () => {
  beforeEach(() => {
    makeCorpus('corpus-a', 'Biology Notes', 'ready', [
      { id: 'corpus-a:0', source: 'bio.txt', chunk_index: 0, text: 'Ribosomes synthesize proteins.' },
    ]);
    makeCorpus('corpus-b', 'Physics Notes', 'ready', [
      { id: 'corpus-b:0', source: 'phys.txt', chunk_index: 0, text: 'Ribosomes are not relevant to physics.' },
    ]);
  });

  test('only searches specified corpus', async () => {
    const result = await knowledgeSearch.handler({ query: 'ribosomes', corpus_id: 'corpus-a' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Biology Notes');
    expect(text).not.toContain('Physics Notes');
  });

  test('error for unknown corpus_id', async () => {
    const result = await knowledgeSearch.handler({ query: 'ribosomes', corpus_id: 'does-not-exist' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('does-not-exist');
  });

  test('error when corpus exists but not ready', async () => {
    makeCorpus('corpus-c', 'Draft', 'ingesting', []);
    const result = await knowledgeSearch.handler({ query: 'anything', corpus_id: 'corpus-c' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('not ready');
  });
});

describe('multi-corpus merge', () => {
  beforeEach(() => {
    makeCorpus('corpus-a', 'Biology Notes', 'ready', [
      { id: 'corpus-a:0', source: 'bio.txt', chunk_index: 0, text: 'Enzymes catalyze biochemical reactions efficiently.' },
    ]);
    makeCorpus('corpus-b', 'Chemistry Notes', 'ready', [
      { id: 'corpus-b:0', source: 'chem.txt', chunk_index: 0, text: 'Enzymes are biological catalysts made of proteins.' },
      { id: 'corpus-b:1', source: 'chem.txt', chunk_index: 1, text: 'Reaction rates depend on enzyme concentration.' },
    ]);
  });

  test('merges results from multiple corpora', async () => {
    const result = await knowledgeSearch.handler({ query: 'enzyme catalyst', k: 3 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Biology Notes');
    expect(text).toContain('Chemistry Notes');
  });

  test('skips non-ready corpora silently', async () => {
    makeCorpus('corpus-c', 'Error Corpus', 'error', []);
    const result = await knowledgeSearch.handler({ query: 'enzyme' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('No ready knowledge corpora found');
  });
});

describe('malformed query', () => {
  beforeEach(() => {
    makeCorpus('corpus-a', 'Test', 'ready', [
      { id: 'corpus-a:0', source: 'file.txt', chunk_index: 0, text: 'Some content here.' },
    ]);
  });

  test('returns error for malformed FTS5 query', async () => {
    const result = await knowledgeSearch.handler({ query: '"unclosed' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Invalid search query');
  });
});

describe('output format', () => {
  beforeEach(() => {
    makeCorpus('corpus-a', 'Biology Notes', 'ready', [
      { id: 'corpus-a:0', source: 'chapter1.txt', chunk_index: 0, text: 'The cell is the basic unit of life.' },
    ]);
  });

  test('output includes corpus name, source, chunk index, score, and text', async () => {
    const result = await knowledgeSearch.handler({ query: 'cell unit life' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Biology Notes');
    expect(text).toContain('chapter1.txt');
    expect(text).toContain('chunk 0');
    expect(text).toMatch(/score: \d+\.\d+/i);
    expect(text).toContain('The cell is the basic unit of life.');
  });
});
