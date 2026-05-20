import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDirectoryMounts, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('assertDirectoryMounts', () => {
  let tmp: string;
  let dir: string;
  let file: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
    dir = path.join(tmp, 'a-dir');
    file = path.join(tmp, 'a-file');
    fs.mkdirSync(dir);
    fs.writeFileSync(file, 'x');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts directory sources', () => {
    expect(() => assertDirectoryMounts([{ hostPath: dir, containerPath: '/x', readonly: false }])).not.toThrow();
  });

  it('throws when any source is a file (the regression we keep catching)', () => {
    expect(() =>
      assertDirectoryMounts([
        { hostPath: dir, containerPath: '/x', readonly: false },
        { hostPath: file, containerPath: '/y', readonly: true },
      ]),
    ).toThrow(/Mount source is a file/);
  });

  it('ignores non-existent paths (legitimate staging slots created at spawn)', () => {
    const ghost = path.join(tmp, 'does-not-exist');
    expect(() => assertDirectoryMounts([{ hostPath: ghost, containerPath: '/x', readonly: false }])).not.toThrow();
  });
});
