import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDirectoryMounts, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude', 'grp1')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude', 'grp1')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode', 'grp1')).toBe('opencode');
  });

  it('throws, naming the group id, when nothing is set (no dead "claude" default)', () => {
    expect(() => resolveProviderName(null, null, undefined, 'grp-no-provider')).toThrow(/grp-no-provider/);
    expect(() => resolveProviderName(null, null, undefined, 'grp-no-provider')).toThrow(/No agent_provider/);
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null, 'grp1')).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null, 'grp1')).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude', 'grp1')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null, 'grp1')).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode', 'grp1')).toBe('opencode');
  });

  it('treats empty string at every level as unset (falls through to throw)', () => {
    expect(() => resolveProviderName('', '', '', 'grp-empty')).toThrow(/grp-empty/);
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
