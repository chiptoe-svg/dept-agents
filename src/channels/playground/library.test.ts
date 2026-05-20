import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listLibrary — cost_tokens + latency_ms', () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-library-'));
    cacheDir = path.join(tmp, 'playground', 'library-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Mark as already-cloned so ensureClone() short-circuits.
    fs.mkdirSync(path.join(cacheDir, '.git'));
    vi.doMock('../../config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../config.js')>();
      return { ...actual, DATA_DIR: tmp };
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeSkill(category: string, name: string, frontmatter: string): void {
    const dir = path.join(cacheDir, category, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n\nBody.\n`);
  }

  it('extracts costTokens + latencyMs from frontmatter', async () => {
    writeSkill(
      'default',
      'web_search',
      'name: web_search\ndescription: Search the web.\ncost_tokens: 400\nlatency_ms: 600',
    );
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const ws = entries.find((e) => e.name === 'web_search');
    expect(ws).toBeDefined();
    expect(ws!.costTokens).toBe(400);
    expect(ws!.latencyMs).toBe(600);
  });

  it('leaves costTokens + latencyMs undefined when frontmatter omits them', async () => {
    writeSkill('default', 'calculator', 'name: calculator\ndescription: Adds numbers.');
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const calc = entries.find((e) => e.name === 'calculator');
    expect(calc).toBeDefined();
    expect(calc!.costTokens).toBeUndefined();
    expect(calc!.latencyMs).toBeUndefined();
  });

  it('ignores non-numeric values', async () => {
    writeSkill('default', 'broken', 'name: broken\ndescription: x\ncost_tokens: lots\nlatency_ms: slow');
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const b = entries.find((e) => e.name === 'broken');
    expect(b).toBeDefined();
    expect(b!.costTokens).toBeUndefined();
    expect(b!.latencyMs).toBeUndefined();
  });
});

describe('listSkillFiles + readSkillFile', () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-files-'));
    cacheDir = path.join(tmp, 'playground', 'library-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.join(cacheDir, '.git')); // short-circuit ensureClone
    vi.doMock('../../config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../config.js')>();
      return { ...actual, DATA_DIR: tmp };
    });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  function makeSkill(category: string, name: string, files: Record<string, string>): void {
    const dir = path.join(cacheDir, category, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  it('listSkillFiles returns nested entries with isDir flags', async () => {
    makeSkill('default', 'web_search', {
      'SKILL.md': '---\nname: web_search\n---\nbody',
      'search.py': 'pass',
      'examples/demo.md': 'demo',
    });
    const { listSkillFiles } = await import('./library.js');
    const files = listSkillFiles('default', 'web_search');
    const paths = files.map((f) => f.path);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain('search.py');
    expect(paths).toContain('examples');
    expect(paths).toContain('examples/demo.md');
    expect(files.find((f) => f.path === 'examples')!.isDir).toBe(true);
    expect(files.find((f) => f.path === 'SKILL.md')!.isDir).toBe(false);
  });

  it('readSkillFile returns the file contents', async () => {
    makeSkill('default', 's', { 'SKILL.md': 'hello' });
    const { readSkillFile } = await import('./library.js');
    expect(readSkillFile('default', 's', 'SKILL.md')).toBe('hello');
  });

  it('readSkillFile rejects path traversal', async () => {
    makeSkill('default', 's', { 'SKILL.md': 'hello' });
    const { readSkillFile } = await import('./library.js');
    expect(readSkillFile('default', 's', '../escape.md')).toBeUndefined();
    expect(readSkillFile('default', 's', 'a/../b')).toBeUndefined();
  });

  it('listSkillFiles + readSkillFile both reject bad category/name', async () => {
    const { listSkillFiles, readSkillFile } = await import('./library.js');
    expect(listSkillFiles('../etc', 's')).toEqual([]);
    expect(readSkillFile('default', '../passwd', 'x')).toBeUndefined();
  });
});
