import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// store.ts resolves folder names under GROUPS_DIR (see benchmarksDir) —
// mock it to the os.tmpdir() parent of tmpDir so `folder` stays a bare
// basename (matching real usage) while the resolved on-disk path equals
// the pre-fix `path.join(tmpDir, ...)` shape every assertion below expects.
let mockGroupsDir: string;
vi.mock('../../config.js', () => ({
  get GROUPS_DIR() {
    return mockGroupsDir;
  },
}));

import { createBenchmark, readBenchmark, writeBenchmark, listBenchmarks, deleteBenchmark } from './store.js';

let tmpDir: string;
let folderName: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-store-'));
  mockGroupsDir = path.dirname(tmpDir);
  folderName = path.basename(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createBenchmark', () => {
  it('creates meta.json with the given name and corpusId', () => {
    const meta = createBenchmark(folderName, { name: 'test bench', corpusId: 'corp1' });
    expect(meta.name).toBe('test bench');
    expect(meta.corpusId).toBe('corp1');
    expect(meta.queries).toEqual([]);
    expect(typeof meta.id).toBe('string');
  });

  it('persists to disk', () => {
    const meta = createBenchmark(folderName, { name: 'b', corpusId: 'c' });
    const read = readBenchmark(folderName, meta.id);
    expect(read.id).toBe(meta.id);
  });

  it('resolves under GROUPS_DIR, not the repo root (regression: was missing the GROUPS_DIR prefix)', () => {
    const meta = createBenchmark(folderName, { name: 'g', corpusId: 'c' });
    const p = path.join(mockGroupsDir, folderName, 'knowledge', 'benchmarks', meta.id, 'meta.json');
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('listBenchmarks', () => {
  it('returns empty array when no benchmarks exist', () => {
    expect(listBenchmarks(folderName)).toEqual([]);
  });

  it('returns all created benchmarks sorted newest first', () => {
    const a = createBenchmark(folderName, { name: 'a', corpusId: 'c' });
    const b = createBenchmark(folderName, { name: 'b', corpusId: 'c' });
    // Force distinct timestamps so sort order is deterministic
    a.createdAt = '2024-01-01T00:00:00.000Z';
    writeBenchmark(folderName, a);
    b.createdAt = '2024-01-02T00:00:00.000Z';
    writeBenchmark(folderName, b);
    // Re-read from disk to pick up the forced timestamps
    const list = listBenchmarks(folderName);
    expect(list.length).toBe(2);
    expect(list[0]!.name).toBe('b'); // newer createdAt sorts first
    expect(list[1]!.name).toBe('a');
  });
});

describe('writeBenchmark', () => {
  it('updates updatedAt and persists', () => {
    const meta = createBenchmark(folderName, { name: 'x', corpusId: 'c' });
    meta.queries.push({ id: 'q1', query: 'hello', relevant: ['world'] });
    writeBenchmark(folderName, meta);
    const read = readBenchmark(folderName, meta.id);
    expect(read.queries.length).toBe(1);
    expect(read.queries[0]!.query).toBe('hello');
  });
});

describe('deleteBenchmark', () => {
  it('removes the benchmark directory', () => {
    const meta = createBenchmark(folderName, { name: 'd', corpusId: 'c' });
    deleteBenchmark(folderName, meta.id);
    expect(() => readBenchmark(folderName, meta.id)).toThrow();
  });

  it('is a no-op for unknown id', () => {
    expect(() => deleteBenchmark(folderName, 'nope')).not.toThrow();
  });
});
