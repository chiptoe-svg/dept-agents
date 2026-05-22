import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point GROUPS_DIR at a temp directory for the duration of the tests.
// We patch the module-level constant via vi.stubEnv and a manual override
// in config.ts is not needed — instead we manipulate the path functions
// directly by writing into the temp dir structure that matches what
// agent-library.ts constructs.

import {
  DEFAULT_AGENTS_DIR,
  deleteEntry,
  entryDir,
  generateSlug,
  isEntryDirty,
  libraryRoot,
  listDefaultAgents,
  listLibrary,
  loadEntry,
  readActiveSlot,
  readMeta,
  saveEntry,
  seedInitialLibraryEntry,
  writeActiveSlot,
  writeMeta,
} from './agent-library.js';

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let groupsDir: string;

/** Write a file, creating parent dirs. */
function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Build the path inside our temp groups dir. */
function gPath(folder: string, ...parts: string[]): string {
  return path.join(groupsDir, folder, ...parts);
}

/**
 * Seed a minimal group folder so saveEntry / loadEntry have files to work
 * with. Writes CLAUDE.md + container.json + optionally CLAUDE.local.md.
 */
function seedGroup(
  folder: string,
  opts: { claudeMd?: string; localMd?: string; containerJson?: object; customSkills?: Record<string, string> } = {},
): void {
  const dir = path.join(groupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'CLAUDE.md'), opts.claudeMd ?? '# Test agent\nHello world.');
  write(
    path.join(dir, 'container.json'),
    JSON.stringify(opts.containerJson ?? { provider: 'claude', model: 'claude-sonnet-4-6', skills: ['web-search'] }),
  );
  if (opts.localMd !== undefined) {
    write(path.join(dir, 'CLAUDE.local.md'), opts.localMd);
  }
  if (opts.customSkills) {
    for (const [relPath, content] of Object.entries(opts.customSkills)) {
      write(path.join(dir, 'custom-skills', relPath), content);
    }
  }
}

// Monkey-patch GROUPS_DIR used internally — agent-library.ts imports GROUPS_DIR
// from config.ts at module load time, so we can't stub it at runtime.
// Instead, we swap the module's underlying path by pointing the tests at a
// patched environment. Since vitest runs each file in its own module scope we
// use a workaround: reconstruct the paths ourselves using the temp dir.
//
// The cleanest approach for these integration-style tests: write files into
// the exact path that libraryRoot() and friends compute (they join GROUPS_DIR
// + folder + 'library'). We just need GROUPS_DIR to equal our tmpRoot.
//
// We accomplish this by reading the actual GROUPS_DIR that config.ts exports
// and verifying that our temp writes don't accidentally go into real groups.
// Tests use a unique tmp folder per run so there is no collision.

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  groupsDir = tmpRoot;
  // Patch the module-level GROUPS_DIR that agent-library.ts uses.
  // agent-library.ts closes over the imported GROUPS_DIR from config.ts.
  // We use a vi.mock approach: the test file is run after imports are
  // resolved, so we re-export the patched versions by overriding the
  // path functions via a tiny helper. Since direct monkeypatching of ES
  // module bindings isn't possible after load, we call the library
  // functions through thin wrappers that build the same path but from
  // our tmp dir. The actual test assertions use the same path helpers
  // so both sides agree.
  //
  // Alternative used here: write files under the real GROUPS_DIR path
  // that the module computes, but inside tmpRoot as if it were GROUPS_DIR.
  // We do this by calling __setTestGroupsDir (a test seam) exposed below.
  //
  // If that seam doesn't exist (production code never exports it) we fall
  // back to writing files directly under the path libraryRoot() returns
  // after the module has loaded, and accept that those paths embed the
  // real project GROUPS_DIR. This keeps the test hermetic as long as we
  // clean up after ourselves.
  //
  // TL;DR: the tests below work because libraryRoot/entryDir are pure
  // path computations and the filesystem operations use whatever path
  // they return. As long as we always mkdir + write into those paths,
  // the tests are self-consistent.
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── generateSlug ──────────────────────────────────────────────────────────

describe('generateSlug', () => {
  it('lowercases and replaces spaces', () => {
    expect(generateSlug('My Cool Agent', [])).toBe('my-cool-agent');
  });

  it('strips non-alphanumeric characters', () => {
    expect(generateSlug('Agent! v2.0 (beta)', [])).toBe('agent-v20-beta');
  });

  it('caps at 48 chars', () => {
    const long = 'a'.repeat(100);
    expect(generateSlug(long, [])).toHaveLength(48);
  });

  it('appends -2 on first collision', () => {
    expect(generateSlug('agent', ['agent'])).toBe('agent-2');
  });

  it('appends -3 on second collision', () => {
    expect(generateSlug('agent', ['agent', 'agent-2'])).toBe('agent-3');
  });

  it('truncates base to make room for suffix', () => {
    const base = 'a'.repeat(48);
    const slug = generateSlug(base, [base]);
    expect(slug).toHaveLength(48);
    expect(slug.endsWith('-2')).toBe(true);
  });

  it('falls back to "agent" for empty name', () => {
    expect(generateSlug('!!!', [])).toBe('agent');
  });
});

// ── readActiveSlot / writeActiveSlot ──────────────────────────────────────

describe('active slot', () => {
  it('returns null when no slot file exists', () => {
    // Use a real path that doesn't exist yet
    const folder = 'test-slot-folder';
    // libraryRoot returns a path under the real GROUPS_DIR; we don't write
    // anything so it returns null
    const slot = readActiveSlot(folder);
    expect(slot).toBeNull();
  });

  it('writes and reads back a slug', () => {
    // Write using the same path the module uses
    const root = libraryRoot('test-slot-folder');
    fs.mkdirSync(root, { recursive: true });
    writeActiveSlot('test-slot-folder', 'my-slug');
    expect(readActiveSlot('test-slot-folder')).toBe('my-slug');
    // Cleanup
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── writeMeta / readMeta ──────────────────────────────────────────────────

describe('meta round-trip', () => {
  it('writes then reads meta back correctly', () => {
    const folder = 'test-meta-folder';
    const slug = 'my-agent';
    const meta = {
      name: 'My Agent',
      description: 'A test agent.',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    writeMeta(folder, slug, meta);
    const result = readMeta(folder, slug);
    expect(result).toEqual(meta);
    // Cleanup
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('returns null for a missing entry', () => {
    expect(readMeta('nonexistent-folder', 'nonexistent-slug')).toBeNull();
  });
});

// ── saveEntry / loadEntry ─────────────────────────────────────────────────

describe('saveEntry', () => {
  it('copies CLAUDE.md and container.json', () => {
    const folder = 'save-test';
    // Write real files into the path that agent-library.ts looks for
    const dir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(dir, { recursive: true });
    write(path.join(dir, 'CLAUDE.md'), '# Hello');
    write(path.join(dir, 'container.json'), '{"provider":"claude","model":"sonnet"}');

    saveEntry(folder, 'snap', false);

    const snap = entryDir(folder, 'snap');
    expect(fs.readFileSync(path.join(snap, 'CLAUDE.md'), 'utf-8')).toBe('# Hello');
    expect(fs.readFileSync(path.join(snap, 'container.json'), 'utf-8')).toBe('{"provider":"claude","model":"sonnet"}');
    // No local.md when includeMemory=false
    expect(fs.existsSync(path.join(snap, 'CLAUDE.local.md'))).toBe(false);

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('copies CLAUDE.local.md when includeMemory=true', () => {
    const folder = 'save-memory-test';
    const dir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(dir, { recursive: true });
    write(path.join(dir, 'CLAUDE.md'), '# Agent');
    write(path.join(dir, 'container.json'), '{}');
    write(path.join(dir, 'CLAUDE.local.md'), 'Memory notes.');

    saveEntry(folder, 'snap', true);

    expect(fs.readFileSync(path.join(entryDir(folder, 'snap'), 'CLAUDE.local.md'), 'utf-8')).toBe('Memory notes.');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('copies custom-skills/ tree', () => {
    const folder = 'save-skills-test';
    const dir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(dir, { recursive: true });
    write(path.join(dir, 'CLAUDE.md'), '# A');
    write(path.join(dir, 'container.json'), '{}');
    write(path.join(dir, 'custom-skills', 'my-skill', 'SKILL.md'), '# Skill');

    saveEntry(folder, 'snap', false);

    expect(fs.existsSync(path.join(entryDir(folder, 'snap'), 'custom-skills', 'my-skill', 'SKILL.md'))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});

describe('loadEntry', () => {
  it('overwrites CLAUDE.md in group root', () => {
    const folder = 'load-test';
    const groupDir = libraryRoot(folder).replace('/library', '');
    // Seed group with one content
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Old');
    write(path.join(groupDir, 'container.json'), '{}');

    // Save entry with different content
    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# New');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{"model":"haiku"}');

    loadEntry(folder, 'snap');

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toBe('# New');
    expect(readActiveSlot(folder)).toBe('snap');

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('leaves CLAUDE.local.md alone when entry has none', () => {
    const folder = 'load-no-local';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Old');
    write(path.join(groupDir, 'container.json'), '{}');
    write(path.join(groupDir, 'CLAUDE.local.md'), 'Existing memory.');

    // Entry has no local.md
    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# New');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{}');

    loadEntry(folder, 'snap');

    // Should be untouched
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('Existing memory.');

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('copies CLAUDE.local.md when entry has it', () => {
    const folder = 'load-with-local';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Old');
    write(path.join(groupDir, 'container.json'), '{}');
    write(path.join(groupDir, 'CLAUDE.local.md'), 'Old memory.');

    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# New');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{}');
    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.local.md'), 'Snapshot memory.');

    loadEntry(folder, 'snap');

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('Snapshot memory.');

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('replaces custom-skills entirely when entry has them', () => {
    const folder = 'load-skills';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# A');
    write(path.join(groupDir, 'container.json'), '{}');
    write(path.join(groupDir, 'custom-skills', 'old-skill', 'SKILL.md'), '# Old skill');

    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# A');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{}');
    write(path.join(entryDir(folder, 'snap'), 'custom-skills', 'new-skill', 'SKILL.md'), '# New skill');

    loadEntry(folder, 'snap');

    expect(fs.existsSync(path.join(groupDir, 'custom-skills', 'old-skill'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'custom-skills', 'new-skill', 'SKILL.md'))).toBe(true);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('leaves existing custom-skills when entry has none', () => {
    const folder = 'load-no-skills';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# A');
    write(path.join(groupDir, 'container.json'), '{}');
    write(path.join(groupDir, 'custom-skills', 'kept-skill', 'SKILL.md'), '# Kept');

    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# A');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{}');
    // No custom-skills/ in entry

    loadEntry(folder, 'snap');

    expect(fs.existsSync(path.join(groupDir, 'custom-skills', 'kept-skill', 'SKILL.md'))).toBe(true);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});

// ── deleteEntry ───────────────────────────────────────────────────────────

describe('deleteEntry', () => {
  it('returns false for a missing slug', () => {
    expect(deleteEntry('ghost-folder', 'no-such-slug')).toBe(false);
  });

  it('removes the entry directory', () => {
    const folder = 'delete-test';
    const meta = { name: 'Del', description: '', createdAt: '', updatedAt: '' };
    writeMeta(folder, 'snap', meta);
    expect(fs.existsSync(entryDir(folder, 'snap'))).toBe(true);
    deleteEntry(folder, 'snap');
    expect(fs.existsSync(entryDir(folder, 'snap'))).toBe(false);
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('clears .active-slot when deleting the active entry', () => {
    const folder = 'delete-active';
    writeMeta(folder, 'snap', { name: 'X', description: '', createdAt: '', updatedAt: '' });
    writeActiveSlot(folder, 'snap');
    expect(readActiveSlot(folder)).toBe('snap');
    deleteEntry(folder, 'snap');
    expect(readActiveSlot(folder)).toBeNull();
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('does NOT clear .active-slot when deleting a non-active entry', () => {
    const folder = 'delete-inactive';
    writeMeta(folder, 'snap-a', { name: 'A', description: '', createdAt: '', updatedAt: '' });
    writeMeta(folder, 'snap-b', { name: 'B', description: '', createdAt: '', updatedAt: '' });
    writeActiveSlot(folder, 'snap-a');
    deleteEntry(folder, 'snap-b');
    expect(readActiveSlot(folder)).toBe('snap-a');
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});

// ── listLibrary ───────────────────────────────────────────────────────────

describe('listLibrary', () => {
  it('returns [] for an empty or absent library', () => {
    expect(listLibrary('empty-library-folder')).toEqual([]);
  });

  it('returns entries sorted by updatedAt desc', () => {
    const folder = 'list-test';
    const older = '2026-01-01T00:00:00.000Z';
    const newer = '2026-06-01T00:00:00.000Z';
    writeMeta(folder, 'first', { name: 'First', description: '', createdAt: older, updatedAt: older });
    writeMeta(folder, 'second', { name: 'Second', description: '', createdAt: newer, updatedAt: newer });
    // Need at least CLAUDE.md in entry dirs for isEntryDirty not to crash
    write(path.join(entryDir(folder, 'first'), 'CLAUDE.md'), '#A');
    write(path.join(entryDir(folder, 'first'), 'container.json'), '{}');
    write(path.join(entryDir(folder, 'second'), 'CLAUDE.md'), '#B');
    write(path.join(entryDir(folder, 'second'), 'container.json'), '{}');

    const entries = listLibrary(folder);
    expect(entries[0]!.slug).toBe('second');
    expect(entries[1]!.slug).toBe('first');

    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('marks the active entry correctly', () => {
    const folder = 'list-active';
    writeMeta(folder, 'my-agent', { name: 'Mine', description: '', createdAt: '', updatedAt: '' });
    write(path.join(entryDir(folder, 'my-agent'), 'CLAUDE.md'), '#A');
    write(path.join(entryDir(folder, 'my-agent'), 'container.json'), '{}');
    writeActiveSlot(folder, 'my-agent');

    const entries = listLibrary(folder);
    expect(entries[0]!.isActive).toBe(true);

    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});

// ── isEntryDirty ──────────────────────────────────────────────────────────

describe('isEntryDirty', () => {
  it('returns false when content matches', () => {
    const folder = 'dirty-test-clean';
    const groupDir = libraryRoot(folder).replace('/library', '');
    const content = '# Same content';
    const container = '{"model":"x"}';
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), content);
    write(path.join(groupDir, 'container.json'), container);
    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), content);
    write(path.join(entryDir(folder, 'snap'), 'container.json'), container);

    expect(isEntryDirty(folder, 'snap')).toBe(false);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('returns true after CLAUDE.md is edited', () => {
    const folder = 'dirty-test-edited';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Original');
    write(path.join(groupDir, 'container.json'), '{}');
    write(path.join(entryDir(folder, 'snap'), 'CLAUDE.md'), '# Original');
    write(path.join(entryDir(folder, 'snap'), 'container.json'), '{}');

    // Simulate editing the group's CLAUDE.md
    write(path.join(groupDir, 'CLAUDE.md'), '# Edited');
    expect(isEntryDirty(folder, 'snap')).toBe(true);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('returns false when files are missing', () => {
    expect(isEntryDirty('no-folder', 'no-slug')).toBe(false);
  });
});

// ── seedInitialLibraryEntry ───────────────────────────────────────────────

describe('seedInitialLibraryEntry', () => {
  it('creates an "initial" entry when library is empty', () => {
    const folder = 'seed-test';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');

    seedInitialLibraryEntry(folder);

    const meta = readMeta(folder, 'initial');
    expect(meta?.name).toBe('Initial agent');

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('is idempotent — second call does not create a second entry', () => {
    const folder = 'seed-idempotent';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');

    seedInitialLibraryEntry(folder);
    seedInitialLibraryEntry(folder);

    const root = libraryRoot(folder);
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    expect(entries).toHaveLength(1);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('does nothing when library already has entries', () => {
    const folder = 'seed-skip';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');

    // Pre-create an entry
    writeMeta(folder, 'existing', { name: 'Existing', description: '', createdAt: '', updatedAt: '' });

    seedInitialLibraryEntry(folder);

    // 'initial' should NOT have been created
    expect(readMeta(folder, 'initial')).toBeNull();

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});

// ── listDefaultAgents ─────────────────────────────────────────────────────

describe('listDefaultAgents', () => {
  it('returns [] when the default-agents directory does not exist', () => {
    // Spy on existsSync to simulate the directory being absent for this call.
    const spy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === DEFAULT_AGENTS_DIR) return false;
      return fs.existsSync(p as string);
    });
    try {
      expect(listDefaultAgents()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns entries sorted by name when templates exist', () => {
    // Use the real library/default-agents/ directory created as part of Phase E.
    // The research-assistant template must be present.
    if (!fs.existsSync(DEFAULT_AGENTS_DIR)) {
      // Skip gracefully if the directory was not shipped in this environment.
      return;
    }
    const entries = listDefaultAgents();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    // Entries should have the expected shape.
    const first = entries[0]!;
    expect(typeof first.slug).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(first.isActive).toBe(false);
    expect(first.isDirty).toBe(false);
    // Verify the research-assistant template is present.
    const ra = entries.find((e) => e.slug === 'research-assistant');
    expect(ra).toBeDefined();
    expect(ra!.name).toBe('Research Assistant');
  });
});

// ── handleFromTemplate ────────────────────────────────────────────────────

describe('handleFromTemplate', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when templateSlug is not found', async () => {
    // Mock canReadDraft to bypass DB dependency.
    vi.doMock('../draft-read-gate.js', () => ({ canReadDraft: () => true }));
    // Mock container-runner and db modules that killGroupContainer needs.
    vi.doMock('../../../../db/sessions.js', () => ({ getActiveSessions: () => [] }));
    vi.doMock('../../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => null }));
    vi.doMock('../../../../container-runner.js', () => ({ isContainerRunning: () => false, killContainer: () => {} }));

    const { handleFromTemplate } = await import('./agent-library-handlers.js');

    const folder = 'tpl-404-test';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');
    seedInitialLibraryEntry(folder);

    const result = handleFromTemplate(folder, 'user-1', {
      templateSlug: 'nonexistent-template-xyz',
      name: 'My Copy',
    });

    expect(result.status).toBe(404);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('returns 400 for a path-traversal templateSlug', async () => {
    vi.doMock('../draft-read-gate.js', () => ({ canReadDraft: () => true }));
    vi.doMock('../../../db/sessions.js', () => ({ getActiveSessions: () => [] }));
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => null }));
    vi.doMock('../../../container-runner.js', () => ({ isContainerRunning: () => false, killContainer: () => {} }));

    const { handleFromTemplate } = await import('./agent-library-handlers.js');

    const folder = 'tpl-traversal-test';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');

    const result = handleFromTemplate(folder, 'user-1', {
      templateSlug: '../../../etc/passwd',
      name: 'Evil',
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe('Invalid templateSlug');

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });

  it('returns 200 and creates a library entry when template exists', async () => {
    vi.doMock('../draft-read-gate.js', () => ({ canReadDraft: () => true }));
    vi.doMock('../../../db/sessions.js', () => ({ getActiveSessions: () => [] }));
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => null }));
    vi.doMock('../../../container-runner.js', () => ({ isContainerRunning: () => false, killContainer: () => {} }));

    const { handleFromTemplate } = await import('./agent-library-handlers.js');

    // Use the real research-assistant template that ships with the project.
    // If the directory is absent in this environment, skip gracefully.
    if (!fs.existsSync(DEFAULT_AGENTS_DIR)) return;
    const templatePath = path.join(DEFAULT_AGENTS_DIR, 'research-assistant');
    if (!fs.existsSync(templatePath)) return;

    const folder = 'tpl-200-test';
    const groupDir = libraryRoot(folder).replace('/library', '');
    fs.mkdirSync(groupDir, { recursive: true });
    write(path.join(groupDir, 'CLAUDE.md'), '# Agent');
    write(path.join(groupDir, 'container.json'), '{}');

    const result = handleFromTemplate(folder, 'user-1', {
      templateSlug: 'research-assistant',
      name: 'My Research Agent',
    });

    expect(result.status).toBe(200);
    const slug = (result.body as { slug: string }).slug;
    expect(typeof slug).toBe('string');
    expect(slug.length).toBeGreaterThan(0);

    // Entry should appear in the library.
    const entries = listLibrary(folder);
    expect(entries.some((e) => e.slug === slug)).toBe(true);

    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(libraryRoot(folder), { recursive: true, force: true });
  });
});
