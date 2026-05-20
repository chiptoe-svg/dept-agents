import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('library storage', () => {
  let tmp: string;
  let libDir: string;
  let studentDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-storage-'));
    libDir = path.join(tmp, 'library');
    studentDir = path.join(tmp, 'student-libraries');
    fs.mkdirSync(libDir);
    fs.mkdirSync(studentDir);
    vi.doMock('../config.js', () => ({
      LIBRARY_DIR: libDir,
      STUDENT_LIBRARIES_DIR: studentDir,
    }));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('listAllTiers returns all three sections', async () => {
    fs.mkdirSync(path.join(libDir, 'default-agents'));
    fs.writeFileSync(
      path.join(libDir, 'default-agents', 'concise_writer.json'),
      JSON.stringify({ name: 'concise_writer', description: 'short answers', persona: '...' }),
    );
    fs.mkdirSync(path.join(libDir, 'class'));
    fs.writeFileSync(
      path.join(libDir, 'class', 'news.json'),
      JSON.stringify({ name: 'news', description: 'class', persona: '...' }),
    );
    fs.mkdirSync(path.join(studentDir, 'student_42'));
    fs.writeFileSync(
      path.join(studentDir, 'student_42', 'baseline.json'),
      JSON.stringify({ name: 'baseline', description: 'mine', persona: '...' }),
    );

    const { listAllTiers } = await import('./storage.js');
    const tiers = listAllTiers('student_42');
    expect(tiers.default).toHaveLength(1);
    expect(tiers.class).toHaveLength(1);
    expect(tiers.my).toHaveLength(1);
    expect(tiers.my[0]!.name).toBe('baseline');
  });

  it('readEntry returns the parsed JSON', async () => {
    fs.mkdirSync(path.join(libDir, 'default-agents'));
    fs.writeFileSync(
      path.join(libDir, 'default-agents', 'cw.json'),
      JSON.stringify({ name: 'cw', description: 'd', persona: 'p', preferredProvider: 'claude' }),
    );
    const { readEntry } = await import('./storage.js');
    const entry = readEntry('default', 'cw', 'student_42');
    expect(entry?.preferredProvider).toBe('claude');
  });

  it('writeMyEntry creates the per-student dir and JSON', async () => {
    const { writeMyEntry, readEntry } = await import('./storage.js');
    writeMyEntry('student_99', 'mine', {
      name: 'mine',
      description: 'desc',
      persona: 'body',
      preferredProvider: 'claude',
      preferredModel: 'claude-haiku-4-5',
      skills: [],
    });
    const entry = readEntry('my', 'mine', 'student_99');
    expect(entry?.name).toBe('mine');
  });

  it('rejects path traversal in entry name', async () => {
    const { writeMyEntry } = await import('./storage.js');
    expect(() =>
      writeMyEntry('student_x', '../escape', {
        name: 'x',
        description: '',
        persona: '',
        preferredProvider: 'claude',
        preferredModel: 'claude-haiku-4-5',
        skills: [],
      }),
    ).toThrow(/invalid name/);
  });
});
