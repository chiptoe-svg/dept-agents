/**
 * Anthropic skills library browser.
 *
 * Ported from origin/main:src/playground/library.ts. Adapted for v2's
 * `log` import and DATA_DIR path convention. Logic is otherwise verbatim.
 *
 * On first use, shallow-clones github.com/anthropics/skills into
 * `data/playground/library-cache/`. Subsequent calls re-use the cache
 * (and git-pull on explicit refresh). Compatibility check parses each
 * SKILL.md frontmatter for tool references not available in NanoClaw
 * containers.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_DIR, DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const LIBRARY_REPO = 'https://github.com/anthropics/skills.git';
const LIBRARY_CACHE_DIR = path.join(DATA_DIR, 'playground', 'library-cache');
/** Category name used for container/skills/* entries in listLibrary output. */
const BUILTIN_CATEGORY = 'built-in';
const BUILTIN_SKILLS_DIR = path.join(CONTAINER_DIR, 'skills');

// Tools available inside NanoClaw containers — kept loose; the runner allows
// most things. Used purely for the compatibility badge.
const NANOCLAW_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'websearch',
  'webfetch',
  'task',
  'taskoutput',
  'taskstop',
  'teamcreate',
  'teamdelete',
  'sendmessage',
  'todowrite',
  'toolsearch',
  'skill',
  'notebookedit',
]);

const KNOWN_INCOMPATIBLE = new Set(['artifacts', 'computer_use', 'computer', 'str_replace_editor']);

export interface LibraryEntry {
  category: string;
  name: string;
  description: string;
  compatibility: 'compatible' | 'partial' | 'incompatible';
  /** Estimated tokens added per turn when this skill is enabled. Best-effort from SKILL.md frontmatter. */
  costTokens?: number;
  /** Estimated latency added per turn (ms). Best-effort from SKILL.md frontmatter. */
  latencyMs?: number;
  /**
   * True for entries sourced from container/skills/* (host-shipped, mounted
   * into every agent container). Distinguishes them visually from the
   * Anthropic-library entries even though they share the same toggle UX.
   */
  builtin?: boolean;
}

export interface LibraryPreview extends LibraryEntry {
  content: string;
  missing: string[];
  incompatible: string[];
}

function ensureClone(refresh = false): void {
  fs.mkdirSync(path.dirname(LIBRARY_CACHE_DIR), { recursive: true });
  const gitDir = path.join(LIBRARY_CACHE_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    if (refresh) {
      const res = spawnSync('git', ['-C', LIBRARY_CACHE_DIR, 'pull', '--ff-only'], { encoding: 'utf-8' });
      if (res.status !== 0) log.warn('Library refresh failed (continuing with cache)', { stderr: res.stderr });
    }
    return;
  }
  const res = spawnSync('git', ['clone', '--depth', '1', LIBRARY_REPO, LIBRARY_CACHE_DIR], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`Library clone failed: ${res.stderr}`);
}

function parseFrontmatter(md: string): Record<string, string> {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function classifyTools(md: string): {
  compatibility: 'compatible' | 'partial' | 'incompatible';
  missing: string[];
  incompatible: string[];
} {
  const fm = parseFrontmatter(md);
  const allowedRaw = fm['allowed-tools'] || '';
  const tools = allowedRaw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  const missing: string[] = [];
  const incompatible: string[] = [];
  for (const t of tools) {
    if (KNOWN_INCOMPATIBLE.has(t)) incompatible.push(t);
    else if (!NANOCLAW_TOOLS.has(t)) missing.push(t);
  }
  if (incompatible.length > 0) return { compatibility: 'incompatible', missing, incompatible };
  if (missing.length > 0) return { compatibility: 'partial', missing, incompatible };
  return { compatibility: 'compatible', missing, incompatible };
}

export function listLibrary(refresh = false): LibraryEntry[] {
  const out: LibraryEntry[] = [];

  // 1. Anthropic-library skills (cloned + cached).
  try {
    ensureClone(refresh);
    const walk = (dir: string, rel: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const subRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, subRel);
        } else if (entry.name === 'SKILL.md') {
          const parts = subRel.split('/');
          if (parts.length < 2) continue;
          const name = parts[parts.length - 2]!;
          const category = parts[0]!;
          const md = fs.readFileSync(full, 'utf-8');
          const fm = parseFrontmatter(md);
          const description = fm.description || '';
          const { compatibility } = classifyTools(md);
          const costTokensRaw = fm['cost_tokens'];
          const latencyMsRaw = fm['latency_ms'];
          const costTokens = costTokensRaw && !isNaN(Number(costTokensRaw)) ? Number(costTokensRaw) : undefined;
          const latencyMs = latencyMsRaw && !isNaN(Number(latencyMsRaw)) ? Number(latencyMsRaw) : undefined;
          out.push({
            category,
            name,
            description,
            compatibility,
            ...(costTokens !== undefined ? { costTokens } : {}),
            ...(latencyMs !== undefined ? { latencyMs } : {}),
          });
        }
      }
    };
    walk(LIBRARY_CACHE_DIR, '');
  } catch (err) {
    log.warn('Library clone unavailable', { err });
  }

  // 2. Container built-ins (host-shipped, mounted into every agent
  //    container). One level deep — each subdir has a SKILL.md.
  try {
    if (fs.existsSync(BUILTIN_SKILLS_DIR)) {
      for (const entry of fs.readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillMd = path.join(BUILTIN_SKILLS_DIR, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const md = fs.readFileSync(skillMd, 'utf-8');
        const fm = parseFrontmatter(md);
        const description = fm.description || '';
        out.push({
          category: BUILTIN_CATEGORY,
          name: entry.name,
          description,
          compatibility: 'compatible',
          builtin: true,
        });
      }
    }
  } catch (err) {
    log.warn('Built-in skills enumeration failed', { err });
  }

  return out.sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
}

export function getLibraryCacheStat(): { exists: boolean; mtime: string | null } {
  if (!fs.existsSync(LIBRARY_CACHE_DIR)) return { exists: false, mtime: null };
  return { exists: true, mtime: fs.statSync(LIBRARY_CACHE_DIR).mtime.toISOString() };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface SkillFileEntry {
  /** Path relative to the skill directory, e.g. "SKILL.md", "examples/demo.md". */
  path: string;
  isDir: boolean;
}

/**
 * Resolve the on-disk root for a given (category, name). Returns null if
 * the category is unknown OR the name doesn't pass the validator (defense
 * against path-traversal in the URL).
 *
 * - `built-in` (BUILTIN_CATEGORY) → container/skills/<name>/
 * - any other category → data/playground/library-cache/<category>/<name>/
 */
function resolveSkillRoot(category: string, name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  if (category === BUILTIN_CATEGORY) return path.join(BUILTIN_SKILLS_DIR, name);
  if (!NAME_RE.test(category)) return null;
  return path.join(LIBRARY_CACHE_DIR, category, name);
}

/** Enumerate all non-hidden files inside a skill's directory. Recursive. */
export function listSkillFiles(category: string, name: string): SkillFileEntry[] {
  const skillDir = resolveSkillRoot(category, name);
  if (!skillDir || !fs.existsSync(skillDir)) return [];
  const out: SkillFileEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path: subRel, isDir: true });
        walk(full, subRel);
      } else if (entry.isFile()) {
        out.push({ path: subRel, isDir: false });
      }
    }
  };
  walk(skillDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one file inside a skill directory. Returns undefined on missing/invalid. */
export function readSkillFile(category: string, name: string, relPath: string): string | undefined {
  const skillDir = resolveSkillRoot(category, name);
  if (!skillDir) return undefined;
  // Reject traversal in the relPath.
  if (relPath.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return undefined;
  const full = path.join(skillDir, relPath);
  // Defense-in-depth: ensure the resolved path stays inside the skill dir.
  if (!path.resolve(full).startsWith(path.resolve(skillDir) + path.sep)) return undefined;
  if (!fs.existsSync(full)) return undefined;
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return undefined;
  }
}
