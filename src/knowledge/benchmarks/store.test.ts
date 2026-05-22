import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBenchmark, readBenchmark, writeBenchmark, listBenchmarks, deleteBenchmark } from './store.js';

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
    const a = createBenchmark(tmpDir, { name: 'a', corpusId: 'c' });
    const b = createBenchmark(tmpDir, { name: 'b', corpusId: 'c' });
    // Force distinct timestamps so sort order is deterministic
    a.createdAt = '2024-01-01T00:00:00.000Z';
    writeBenchmark(tmpDir, a);
    b.createdAt = '2024-01-02T00:00:00.000Z';
    writeBenchmark(tmpDir, b);
    // Re-read from disk to pick up the forced timestamps
    const list = listBenchmarks(tmpDir);
    expect(list.length).toBe(2);
    expect(list[0]!.name).toBe('b'); // newer createdAt sorts first
    expect(list[1]!.name).toBe('a');
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
