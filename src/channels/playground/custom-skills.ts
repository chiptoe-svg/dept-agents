/**
 * Per-agent custom skills.
 *
 * The Skills tab's editor saves named custom skills here. Unlike the
 * shared built-in (`container/skills/*`) and Anthropic-library skills,
 * a custom skill belongs to one agent group and is stored under its
 * group folder at `groups/<folder>/custom-skills/<name>/`.
 *
 * A custom skill is a directory of files (always at least `SKILL.md`).
 * The group folder is mounted into the container at `/workspace/agent`,
 * so a custom skill is reachable in-container at
 * `/workspace/agent/custom-skills/<name>` — `syncSkillSymlinks`
 * (container-runner.ts) points `.claude-shared/skills/<name>` there
 * instead of the shared `/app/skills/<name>` when a custom copy exists.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

/** Skill-directory name validator — no traversal, no dotfiles. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Per-file byte cap — a custom-skill file is prose/markdown, not a blob. */
const MAX_FILE_BYTES = 256 * 1024;
/** Per-skill file-count cap — bounds editor-driven host-disk growth. */
const MAX_FILES_PER_SKILL = 50;

export interface CustomSkillEntry {
  name: string;
  description: string;
}

export interface CustomSkillFile {
  /** Path relative to the skill directory, e.g. "SKILL.md", "examples/demo.md". */
  path: string;
  isDir: boolean;
}

function customSkillsRoot(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'custom-skills');
}

/** Best-effort `description:` from SKILL.md frontmatter. */
function parseDescription(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return '';
  for (const line of fm[1]!.split('\n')) {
    const m = line.match(/^description:\s*(.+)$/);
    if (m) return m[1]!.trim();
  }
  return '';
}

/**
 * Resolve a file path inside a skill, rejecting anything that would escape
 * the skill directory. Returns the absolute path or null when invalid.
 */
function resolveSkillFile(folder: string, name: string, relPath: string): string | null {
  if (!NAME_RE.test(name)) return null;
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '' || seg === '..' || seg.startsWith('.'))) return null;
  if (!segments.every((seg) => NAME_RE.test(seg))) return null;
  const skillDir = path.join(customSkillsRoot(folder), name);
  const full = path.join(skillDir, relPath);
  // Defense-in-depth: ensure the resolved path stays inside the skill dir.
  if (full !== skillDir && !path.resolve(full).startsWith(path.resolve(skillDir) + path.sep)) return null;
  return full;
}

export function listCustomSkills(folder: string): CustomSkillEntry[] {
  const root = customSkillsRoot(folder);
  if (!fs.existsSync(root)) return [];
  const out: CustomSkillEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillMd = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    out.push({ name: entry.name, description: parseDescription(fs.readFileSync(skillMd, 'utf-8')) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumerate every non-hidden file inside a custom skill. Recursive. */
export function listCustomSkillFiles(folder: string, name: string): CustomSkillFile[] {
  if (!NAME_RE.test(name)) return [];
  const skillDir = path.join(customSkillsRoot(folder), name);
  if (!fs.existsSync(skillDir)) return [];
  const out: CustomSkillFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path: subRel, isDir: true });
        walk(path.join(dir, entry.name), subRel);
      } else if (entry.isFile()) {
        out.push({ path: subRel, isDir: false });
      }
    }
  };
  walk(skillDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readCustomSkillFile(folder: string, name: string, relPath: string): string | undefined {
  const full = resolveSkillFile(folder, name, relPath);
  if (!full || !fs.existsSync(full)) return undefined;
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return undefined;
  }
}

export function customSkillExists(folder: string, name: string): boolean {
  return NAME_RE.test(name) && fs.existsSync(path.join(customSkillsRoot(folder), name, 'SKILL.md'));
}

/**
 * Create or overwrite one file inside a custom skill. Throws on a bad
 * name/path, an oversized file, or a skill that already holds the
 * maximum number of files.
 */
export function writeCustomSkillFile(folder: string, name: string, relPath: string, content: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('skill name must be alphanumeric (dashes, dots, underscores allowed)');
  }
  const full = resolveSkillFile(folder, name, relPath);
  if (!full) throw new Error(`invalid file path: ${relPath}`);
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${bytes} bytes (max ${MAX_FILE_BYTES})`);
  }
  // File-count cap — only enforced when adding a NEW file; overwriting an
  // existing one keeps the count flat.
  if (!fs.existsSync(full)) {
    const count = listCustomSkillFiles(folder, name).filter((f) => !f.isDir).length;
    if (count >= MAX_FILES_PER_SKILL) {
      throw new Error(`skill "${name}" already has ${count} files (max ${MAX_FILES_PER_SKILL})`);
    }
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Delete a whole custom skill. Returns false when the name is invalid or absent. */
export function deleteCustomSkill(folder: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const dir = path.join(customSkillsRoot(folder), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
