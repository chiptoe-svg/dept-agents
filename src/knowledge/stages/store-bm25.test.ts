import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBm25Index, queryBm25 } from './store-bm25.js';
import type { Chunk } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeChunks(): Chunk[] {
  return [
    { id: 'c:0', corpusId: 'c', source: 'f.txt', text: 'The quick brown fox jumps', index: 0 },
    { id: 'c:1', corpusId: 'c', source: 'f.txt', text: 'A lazy dog sleeps all day', index: 1 },
    { id: 'c:2', corpusId: 'c', source: 'f.txt', text: 'The fox and the dog are friends', index: 2 },
  ];
}

describe('buildBm25Index', () => {
  it('creates bm25.db in the given dir', () => {
    buildBm25Index(tmpDir, makeChunks());
    expect(fs.existsSync(path.join(tmpDir, 'bm25.db'))).toBe(true);
  });

  it('overwrites an existing index', () => {
    buildBm25Index(tmpDir, makeChunks());
    buildBm25Index(tmpDir, makeChunks());
    expect(fs.existsSync(path.join(tmpDir, 'bm25.db'))).toBe(true);
  });
});

describe('queryBm25', () => {
  it('returns results ranked by relevance', () => {
    buildBm25Index(tmpDir, makeChunks());
    const results = queryBm25(tmpDir, 'fox', 5);
    expect(results.length).toBeGreaterThan(0);
    const texts = results.map((r) => r.chunk.text);
    expect(texts.some((t) => t.includes('fox'))).toBe(true);
    // Scores descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score >= results[i].score).toBe(true);
    }
  });

  it('returns at most k results', () => {
    buildBm25Index(tmpDir, makeChunks());
    const results = queryBm25(tmpDir, 'the', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array for malformed query', () => {
    buildBm25Index(tmpDir, makeChunks());
    const results = queryBm25(tmpDir, 'AND OR', 5);
    expect(results).toEqual([]);
  });

  it('returns empty array when db does not exist', () => {
    const results = queryBm25(tmpDir, 'anything', 5);
    expect(results).toEqual([]);
  });
});
