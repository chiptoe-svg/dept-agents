/**
 * Tests for readAgentSources in export.ts.
 *
 * Uses a real temp directory so we test the actual FS logic without mocking
 * the entire fs module. The module-level GROUPS_DIR is baked in at import
 * time, but we bypass it by passing rootDirOverride for library-entry tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readAgentSources } from './export.js';

let tmpRoot: string;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-export-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── readAgentSources with rootDirOverride ──────────────────────────────────

describe('readAgentSources with rootDirOverride', () => {
  it('returns null when CLAUDE.md is absent', () => {
    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).toBeNull();
  });

  it('reads CLAUDE.md from the override directory', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# My Agent\nHello from library entry.');
    write(path.join(tmpRoot, 'container.json'), JSON.stringify({ provider: 'claude', model: 'claude-sonnet-4-6' }));

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.claudeMd).toContain('Hello from library entry.');
    expect(result!.provider).toBe('claude');
    expect(result!.model).toBe('claude-sonnet-4-6');
  });

  it('reads custom skills from the override directory', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');
    // Write a custom skill with a SKILL.md and a script file
    const skillDir = path.join(tmpRoot, 'custom-skills', 'my-skill');
    write(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Does something cool\n---\n# My Skill\n');
    write(path.join(skillDir, 'run.sh'), '#!/bin/bash\necho hello');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.customSkills).toHaveLength(1);
    expect(result!.customSkills[0]!.name).toBe('my-skill');
    expect(result!.customSkills[0]!.description).toBe('Does something cool');
    expect(result!.customSkills[0]!.files['SKILL.md']).toContain('Does something cool');
    expect(result!.customSkills[0]!.files['run.sh']).toContain('echo hello');
  });

  it('handles a custom skill with no SKILL.md (no description, still collects files)', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');
    const skillDir = path.join(tmpRoot, 'custom-skills', 'bare-skill');
    write(path.join(skillDir, 'main.py'), 'print("hi")');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.customSkills).toHaveLength(1);
    expect(result!.customSkills[0]!.name).toBe('bare-skill');
    expect(result!.customSkills[0]!.description).toBe('');
    expect(result!.customSkills[0]!.files['main.py']).toContain('print("hi")');
  });

  it('collects files recursively from nested subdirectories', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');
    const skillDir = path.join(tmpRoot, 'custom-skills', 'nested-skill');
    write(path.join(skillDir, 'SKILL.md'), '---\ndescription: Nested\n---\n');
    write(path.join(skillDir, 'lib', 'helper.js'), '// helper');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    const skill = result!.customSkills[0]!;
    expect(skill.files[path.join('lib', 'helper.js')]).toContain('// helper');
  });

  it('skips dot-prefixed skill directories', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');
    // A hidden skill directory — should be ignored
    write(path.join(tmpRoot, 'custom-skills', '.hidden-skill', 'SKILL.md'), '---\ndescription: Hidden\n---\n');
    // A visible skill directory — should be included
    write(path.join(tmpRoot, 'custom-skills', 'visible-skill', 'SKILL.md'), '---\ndescription: Visible\n---\n');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.customSkills).toHaveLength(1);
    expect(result!.customSkills[0]!.name).toBe('visible-skill');
  });

  it('returns empty customSkills when custom-skills directory does not exist', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.customSkills).toHaveLength(0);
  });

  it('reads CLAUDE.local.md when present', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');
    write(path.join(tmpRoot, 'CLAUDE.local.md'), 'My memory note.');

    const result = readAgentSources('any-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.claudeLocalMd).toBe('My memory note.');
  });

  it('uses folder as assistantName when container.json is absent', () => {
    write(path.join(tmpRoot, 'CLAUDE.md'), '# Agent');

    const result = readAgentSources('my-folder', tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.assistantName).toBe('my-folder');
    expect(result!.folder).toBe('my-folder');
  });
});

// ── readAgentSources without override (standard group path) ────────────────

describe('readAgentSources without rootDirOverride', () => {
  it('returns null for a non-existent folder (no CLAUDE.md in groups dir)', () => {
    // Pass a folder name that is guaranteed not to exist in the real GROUPS_DIR
    const result = readAgentSources('__nonexistent_test_folder_zzz__');
    expect(result).toBeNull();
  });
});
