import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// corpus.ts resolves folder names under GROUPS_DIR (see corporaDir) — mock
// it to the os.tmpdir() parent of tmpFolder so the `folder` argument stays
// a bare basename (matching real usage: a group's `folder` field, not an
// absolute path) while the resolved on-disk path equals the pre-fix
// `path.join(tmpFolder, ...)` shape every assertion below already expects.
let mockGroupsDir: string;
vi.mock('../config.js', () => ({
  get GROUPS_DIR() {
    return mockGroupsDir;
  },
}));

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
let folderName: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
  mockGroupsDir = path.dirname(tmpFolder);
  folderName = path.basename(tmpFolder);
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
});

describe('corporaDir / corpusDir', () => {
  it('returns stable paths under the folder', () => {
    expect(corporaDir(folderName)).toBe(path.join(tmpFolder, 'knowledge', 'corpora'));
    expect(corpusDir(folderName, 'abc')).toBe(path.join(tmpFolder, 'knowledge', 'corpora', 'abc'));
  });

  it('resolves under GROUPS_DIR, not the repo root (regression: was missing the GROUPS_DIR prefix)', () => {
    expect(corporaDir(folderName).startsWith(mockGroupsDir + path.sep)).toBe(true);
    expect(corpusDir(folderName, 'abc').startsWith(mockGroupsDir + path.sep)).toBe(true);
  });
});

describe('createCorpus', () => {
  it('creates directory structure and returns meta', () => {
    const meta = createCorpus(folderName, { name: 'test corpus', sourceType: 'text' });
    expect(meta.name).toBe('test corpus');
    expect(meta.sourceType).toBe('text');
    expect(meta.status).toBe('empty');
    expect(fs.existsSync(corpusDir(folderName, meta.id))).toBe(true);
    expect(fs.existsSync(path.join(corpusDir(folderName, meta.id), 'raw'))).toBe(true);
  });
});

describe('readMeta / writeMeta', () => {
  it('round-trips meta through disk', () => {
    const meta = createCorpus(folderName, { name: 'x', sourceType: 'text' });
    meta.chunkStrategy = 'fixed';
    writeMeta(folderName, meta.id, meta);
    const loaded = readMeta(folderName, meta.id);
    expect(loaded.chunkStrategy).toBe('fixed');
  });
});

describe('updateStatus', () => {
  it('sets status and errorMessage', () => {
    const meta = createCorpus(folderName, { name: 'x', sourceType: 'text' });
    updateStatus(folderName, meta.id, 'error', 'boom');
    expect(readMeta(folderName, meta.id).status).toBe('error');
    expect(readMeta(folderName, meta.id).errorMessage).toBe('boom');
  });
});

describe('listCorpora', () => {
  it('returns all corpora ordered by createdAt desc', () => {
    const metaA = createCorpus(folderName, { name: 'a', sourceType: 'text' });
    // Force corpus A to have an earlier timestamp
    metaA.createdAt = '2020-01-01T00:00:00.000Z';
    writeMeta(folderName, metaA.id, metaA);

    const metaB = createCorpus(folderName, { name: 'b', sourceType: 'text' });

    const list = listCorpora(folderName);
    expect(list).toHaveLength(2);
    // B should come first (newer)
    expect(list[0].id).toBe(metaB.id);
    expect(list[1].id).toBe(metaA.id);
  });
});

describe('deleteCorpus', () => {
  it('removes directory', () => {
    const meta = createCorpus(folderName, { name: 'x', sourceType: 'text' });
    deleteCorpus(folderName, meta.id);
    expect(fs.existsSync(corpusDir(folderName, meta.id))).toBe(false);
  });

  it('no-ops on missing id', () => {
    expect(() => deleteCorpus(folderName, 'nope')).not.toThrow();
  });
});
