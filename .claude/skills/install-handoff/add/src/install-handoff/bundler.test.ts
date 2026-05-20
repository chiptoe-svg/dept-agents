import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Per-test tmpdir + env setup
// ---------------------------------------------------------------------------

let tmpRoot: string;
let fakeHome: string;
let fakeProjectRoot: string;
let fakeDataDir: string;
let fakeGroupsDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  fakeHome = path.join(tmpRoot, 'home');
  fakeProjectRoot = path.join(tmpRoot, 'project');
  fakeDataDir = path.join(fakeProjectRoot, 'data');
  fakeGroupsDir = path.join(fakeProjectRoot, 'groups');

  // Create skeleton dirs.
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeDataDir, { recursive: true });

  // Override HOME so homeDir() in bundler resolves to our fake home.
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;

  // Mock config so DATA_DIR + GROUPS_DIR point at tmpdir.
  vi.doMock('../config.js', () => ({
    DATA_DIR: fakeDataDir,
    GROUPS_DIR: fakeGroupsDir,
  }));

  // Silence log output during tests.
  vi.doMock('../log.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  }));
});

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bundler() {
  return import('./bundler.js');
}

const TOKEN = 'deadbeef12345678deadbeef12345678'; // 32-char hex

function bundleDir(): string {
  return path.join(fakeDataDir, 'handoffs', TOKEN);
}

/** Write a small fake file at the given absolute path (creates dirs). */
function seedFile(absPath: string, content = 'fake content'): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

/** Seed all "default-manifest" source files (.env, gws, codex). */
function seedDefaults(): void {
  seedFile(path.join(fakeProjectRoot, '.env'), 'ASSISTANT_NAME=TestBot\nANTHROPIC_API_KEY=sk-fake');
  seedFile(path.join(fakeHome, '.config', 'gws', 'credentials.json'), '{"gws":"creds"}');
  seedFile(path.join(fakeHome, '.config', 'gws', 'client_secret.json'), '{"gws":"secret"}');
  seedFile(path.join(fakeHome, '.codex', 'auth.json'), '{"codex":"auth"}');
  seedFile(path.join(fakeHome, '.codex', 'config.toml'), '[settings]\nmodel="gpt-4o"');
}

// ---------------------------------------------------------------------------
// Default manifest: env + gws + codex all present
// ---------------------------------------------------------------------------

describe('default manifest (env + gws + codex)', () => {
  it('bundles all three when source files exist and returns correct file list', async () => {
    seedDefaults();
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, gws: true, codex: true });

    expect(result.bundleDir).toBe(bundleDir());

    // All 5 files: env + gws x2 + codex x2
    const names = result.files.map((f) => f.name).sort();
    expect(names).toEqual(['codex-auth.json', 'codex-config.toml', 'env', 'gws-client_secret.json', 'gws-credentials.json'].sort());

    // Sizes are non-zero
    for (const f of result.files) {
      expect(f.size).toBeGreaterThan(0);
    }
  });

  it('returns sizes matching actual file sizes', async () => {
    seedDefaults();
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, gws: true, codex: true });

    const envEntry = result.files.find((f) => f.name === 'env');
    expect(envEntry).toBeDefined();
    const actualSize = fs.statSync(path.join(bundleDir(), 'env')).size;
    expect(envEntry!.size).toBe(actualSize);
  });
});

// ---------------------------------------------------------------------------
// Missing .env → throw
// ---------------------------------------------------------------------------

describe('missing .env', () => {
  it('throws a clear error when .env is absent and env: true', async () => {
    // Do NOT seed .env
    const { bundleHandoff } = await bundler();
    expect(() => bundleHandoff(TOKEN, { env: true })).toThrow('install-handoff: required file .env not found');
  });

  it('throws even with default manifest (env defaults to true)', async () => {
    const { bundleHandoff } = await bundler();
    // No seeds at all
    expect(() => bundleHandoff(TOKEN, {})).toThrow('install-handoff: required file .env not found');
  });
});

// ---------------------------------------------------------------------------
// GWS: present and absent
// ---------------------------------------------------------------------------

describe('gws credential handling', () => {
  it('skips silently when gws credentials are absent', async () => {
    // Seed only .env — no GWS files
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, gws: true });

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('gws-credentials.json');
    expect(names).not.toContain('gws-client_secret.json');
    // Should not throw
  });

  it('bundles gws-credentials.json when present even if client_secret.json absent', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    seedFile(path.join(fakeHome, '.config', 'gws', 'credentials.json'), '{"gws":"creds"}');
    // No client_secret.json
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, gws: true });

    const names = result.files.map((f) => f.name);
    expect(names).toContain('gws-credentials.json');
    expect(names).not.toContain('gws-client_secret.json');
  });
});

// ---------------------------------------------------------------------------
// Codex: present and absent
// ---------------------------------------------------------------------------

describe('codex credential handling', () => {
  it('skips silently when codex files are absent', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, codex: true });

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('codex-auth.json');
    expect(names).not.toContain('codex-config.toml');
  });

  it('bundles codex-auth.json when auth.json present but config.toml absent', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    seedFile(path.join(fakeHome, '.codex', 'auth.json'), '{"token":"xyz"}');
    // No config.toml
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, codex: true });

    const names = result.files.map((f) => f.name);
    expect(names).toContain('codex-auth.json');
    expect(names).not.toContain('codex-config.toml');
  });
});

// ---------------------------------------------------------------------------
// claudeCreds: opt-in
// ---------------------------------------------------------------------------

describe('claudeCreds opt-in', () => {
  it('bundles claude-credentials.json when claudeCreds: true and file present', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    seedFile(path.join(fakeHome, '.claude', '.credentials.json'), '{"oauth":"token"}');
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, claudeCreds: true });

    const names = result.files.map((f) => f.name);
    expect(names).toContain('claude-credentials.json');
  });

  it('skips silently when claudeCreds: true but file absent', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    // No ~/.claude/.credentials.json
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, claudeCreds: true });

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('claude-credentials.json');
  });

  it('does NOT include claude-credentials.json when claudeCreds is omitted (default false)', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    seedFile(path.join(fakeHome, '.claude', '.credentials.json'), '{"oauth":"token"}');
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true }); // claudeCreds not set

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('claude-credentials.json');
  });
});

// ---------------------------------------------------------------------------
// groups/ tarball
// ---------------------------------------------------------------------------

describe('groups/ tarball', () => {
  it('produces groups.tar.gz when groups: true and groups/ dir has content', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    // Seed a groups/ dir with one agent group and a data/ subdir that should be excluded
    const agentDir = path.join(fakeGroupsDir, 'my-agent');
    fs.mkdirSync(path.join(agentDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# Claude');
    fs.writeFileSync(path.join(agentDir, 'data', 'sessions.db'), 'db-content');

    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, groups: true });

    const names = result.files.map((f) => f.name);
    expect(names).toContain('groups.tar.gz');

    // Verify archive contents: should include CLAUDE.md, should NOT include data/sessions.db
    const tarOut = execFileSync('tar', ['tzf', path.join(bundleDir(), 'groups.tar.gz')], {
      encoding: 'utf8',
    });
    const tarLines = tarOut.trim().split('\n');
    expect(tarLines.some((l) => l.includes('CLAUDE.md'))).toBe(true);
    expect(tarLines.some((l) => l.includes('sessions.db'))).toBe(false);
    expect(tarLines.some((l) => l.includes('/data/'))).toBe(false);
  });

  it('skips silently when groups/ dir does not exist', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    // Do NOT create fakeGroupsDir
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, groups: true });

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('groups.tar.gz');
  });

  it('skips silently when groups/ dir is empty', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    fs.mkdirSync(fakeGroupsDir, { recursive: true });
    // Empty dir — no entries
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true, groups: true });

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('groups.tar.gz');
  });

  it('does NOT produce groups.tar.gz when groups is omitted (default false)', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    fs.mkdirSync(path.join(fakeGroupsDir, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(fakeGroupsDir, 'agent', 'CLAUDE.md'), '# Claude');

    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true }); // groups not set

    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('groups.tar.gz');
  });
});

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

describe('file permissions', () => {
  it('sets 0600 on all output files', async () => {
    seedDefaults();
    const { bundleHandoff } = await bundler();
    bundleHandoff(TOKEN, { env: true, gws: true, codex: true });

    const outDir = bundleDir();
    const entries = fs.readdirSync(outDir);
    for (const name of entries) {
      const stat = fs.statSync(path.join(outDir, name));
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('sets 0600 on groups.tar.gz when groups: true', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    const agentDir = path.join(fakeGroupsDir, 'my-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    seedFile(path.join(agentDir, 'CLAUDE.md'), '# Agent persona');
    const { bundleHandoff } = await bundler();
    bundleHandoff(TOKEN, { env: true, groups: true });

    const tarPath = path.join(bundleDir(), 'groups.tar.gz');
    // eslint-disable-next-line no-bitwise
    const mode = fs.statSync(tarPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates bundleDir with mode 0700', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    const { bundleHandoff } = await bundler();
    bundleHandoff(TOKEN, { env: true });

    const stat = fs.statSync(bundleDir());
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// bundleDir path
// ---------------------------------------------------------------------------

describe('bundleDir path', () => {
  it('is data/handoffs/<token>/ under fakeDataDir', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    const { bundleHandoff } = await bundler();
    const result = bundleHandoff(TOKEN, { env: true });
    expect(result.bundleDir).toBe(path.join(fakeDataDir, 'handoffs', TOKEN));
  });

  it('creates the bundle directory even if handoffs/ parent did not exist', async () => {
    seedFile(path.join(fakeProjectRoot, '.env'), 'X=1');
    // fakeDataDir exists but handoffs/ subdir does not
    const { bundleHandoff } = await bundler();
    bundleHandoff(TOKEN, { env: true });
    expect(fs.existsSync(bundleDir())).toBe(true);
  });
});
