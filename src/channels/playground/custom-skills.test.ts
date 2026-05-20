import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('custom-skills', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-skills-'));
    // custom-skills.ts only consumes GROUPS_DIR from config.
    vi.doMock('../../config.js', () => ({ GROUPS_DIR: tmp }));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('write → list files → list skills → read round-trips (multi-file)', async () => {
    const { writeCustomSkillFile, listCustomSkillFiles, listCustomSkills, readCustomSkillFile } =
      await import('./custom-skills.js');
    writeCustomSkillFile('grp', 'my-skill', 'SKILL.md', '---\nname: my-skill\ndescription: Does a thing.\n---\n# Body');
    writeCustomSkillFile('grp', 'my-skill', 'examples/demo.md', 'demo content');
    expect(listCustomSkills('grp')).toEqual([{ name: 'my-skill', description: 'Does a thing.' }]);
    const paths = listCustomSkillFiles('grp', 'my-skill')
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(['SKILL.md', 'examples', 'examples/demo.md'].sort());
    expect(readCustomSkillFile('grp', 'my-skill', 'examples/demo.md')).toBe('demo content');
  });

  it('listCustomSkills returns [] for a group with none', async () => {
    const { listCustomSkills } = await import('./custom-skills.js');
    expect(listCustomSkills('empty-grp')).toEqual([]);
  });

  it('rejects invalid skill names and traversal paths on write', async () => {
    const { writeCustomSkillFile } = await import('./custom-skills.js');
    expect(() => writeCustomSkillFile('grp', '../escape', 'SKILL.md', 'x')).toThrow();
    expect(() => writeCustomSkillFile('grp', 'ok', '../escape.md', 'x')).toThrow();
    expect(() => writeCustomSkillFile('grp', 'ok', 'sub/../../escape.md', 'x')).toThrow();
  });

  it('readCustomSkillFile returns undefined for a bad name/path or missing file', async () => {
    const { readCustomSkillFile } = await import('./custom-skills.js');
    expect(readCustomSkillFile('grp', 'nope', 'SKILL.md')).toBeUndefined();
    expect(readCustomSkillFile('grp', '../etc', 'passwd')).toBeUndefined();
  });

  it('delete removes the skill; returns false when absent', async () => {
    const { writeCustomSkillFile, deleteCustomSkill, customSkillExists } = await import('./custom-skills.js');
    writeCustomSkillFile('grp', 'temp', 'SKILL.md', 'x');
    expect(customSkillExists('grp', 'temp')).toBe(true);
    expect(deleteCustomSkill('grp', 'temp')).toBe(true);
    expect(customSkillExists('grp', 'temp')).toBe(false);
    expect(deleteCustomSkill('grp', 'temp')).toBe(false);
  });
});
