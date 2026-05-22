import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  corpusDir,
  corporaDir,
  createCorpus,
  readMeta,
  writeMeta,
  updateStatus,
  listCorpora,
  deleteCorpus,
} from './corpus.js';

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
});

describe('corporaDir / corpusDir', () => {
  it('returns stable paths under the folder', () => {
    expect(corporaDir(tmpFolder)).toBe(path.join(tmpFolder, 'knowledge', 'corpora'));
    expect(corpusDir(tmpFolder, 'abc')).toBe(path.join(tmpFolder, 'knowledge', 'corpora', 'abc'));
  });
});

describe('createCorpus', () => {
  it('creates directory structure and returns meta', () => {
    const meta = createCorpus(tmpFolder, { name: 'test corpus', sourceType: 'text' });
    expect(meta.name).toBe('test corpus');
    expect(meta.sourceType).toBe('text');
    expect(meta.status).toBe('empty');
    expect(fs.existsSync(corpusDir(tmpFolder, meta.id))).toBe(true);
    expect(fs.existsSync(path.join(corpusDir(tmpFolder, meta.id), 'raw'))).toBe(true);
  });
});

describe('readMeta / writeMeta', () => {
  it('round-trips meta through disk', () => {
    const meta = createCorpus(tmpFolder, { name: 'x', sourceType: 'text' });
    meta.chunkStrategy = 'fixed';
    writeMeta(tmpFolder, meta.id, meta);
    const loaded = readMeta(tmpFolder, meta.id);
    expect(loaded.chunkStrategy).toBe('fixed');
  });
});

describe('updateStatus', () => {
  it('sets status and errorMessage', () => {
    const meta = createCorpus(tmpFolder, { name: 'x', sourceType: 'text' });
    updateStatus(tmpFolder, meta.id, 'error', 'boom');
    expect(readMeta(tmpFolder, meta.id).status).toBe('error');
    expect(readMeta(tmpFolder, meta.id).errorMessage).toBe('boom');
  });
});

describe('listCorpora', () => {
  it('returns all corpora ordered by createdAt desc', () => {
    const metaA = createCorpus(tmpFolder, { name: 'a', sourceType: 'text' });
    // Force corpus A to have an earlier timestamp
    metaA.createdAt = '2020-01-01T00:00:00.000Z';
    writeMeta(tmpFolder, metaA.id, metaA);

    const metaB = createCorpus(tmpFolder, { name: 'b', sourceType: 'text' });

    const list = listCorpora(tmpFolder);
    expect(list).toHaveLength(2);
    // B should come first (newer)
    expect(list[0].id).toBe(metaB.id);
    expect(list[1].id).toBe(metaA.id);
  });
});

describe('deleteCorpus', () => {
  it('removes directory', () => {
    const meta = createCorpus(tmpFolder, { name: 'x', sourceType: 'text' });
    deleteCorpus(tmpFolder, meta.id);
    expect(fs.existsSync(corpusDir(tmpFolder, meta.id))).toBe(false);
  });

  it('no-ops on missing id', () => {
    expect(() => deleteCorpus(tmpFolder, 'nope')).not.toThrow();
  });
});
