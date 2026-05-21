/**
 * Agent library — per-user named agent portfolio.
 *
 * Each user can maintain up to 20 named agent snapshots stored under
 * `groups/<folder>/library/<slug>/`. One is "active" at a time (tracked
 * by `library/.active-slot`). Load copies files back to the group root
 * and kills any running container so the next message uses the loaded agent.
 *
 * Phase A — storage layer  (this file)
 * Phase B — dirty detection (this file)
 * Phase C — API handlers   (see api-routes.ts)
 *
 * Design: docs/superpowers/specs/2026-05-21-agent-library-design.md
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../../config.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentMeta {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryEntry {
  slug: string;
  name: string;
  description: string;
  updatedAt: string;
  isActive: boolean;
  isDirty: boolean;
  provider: string;
  model: string;
  builtinSkills: string[];
  customSkillCount: number;
}

// ── Path helpers ──────────────────────────────────────────────────────────

export function libraryRoot(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'library');
}

export function entryDir(folder: string, slug: string): string {
  return path.join(libraryRoot(folder), slug);
}

// ── Slug generation ───────────────────────────────────────────────────────

/**
 * Derive a URL-safe slug from `name`. Collisions resolved by appending
 * `-2`, `-3`, etc. Max 48 chars total.
 */
export function generateSlug(name: string, existing: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 48) || 'agent';

  if (!existing.includes(base)) return base;

  for (let n = 2; n <= 100; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 48 - suffix.length) + suffix;
    if (!existing.includes(candidate)) return candidate;
  }
  // Fallback: timestamp suffix (collision storm is astronomically unlikely)
  return base.slice(0, 35) + `-${Date.now()}`;
}

// ── Active slot ───────────────────────────────────────────────────────────

export function readActiveSlot(folder: string): string | null {
  const slotPath = path.join(libraryRoot(folder), '.active-slot');
  if (!fs.existsSync(slotPath)) return null;
  const content = fs.readFileSync(slotPath, 'utf-8').trim();
  return content || null;
}

export function writeActiveSlot(folder: string, slug: string): void {
  const root = libraryRoot(folder);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.active-slot'), slug + '\n');
}

function clearActiveSlot(folder: string): void {
  const slotPath = path.join(libraryRoot(folder), '.active-slot');
  if (fs.existsSync(slotPath)) fs.rmSync(slotPath, { force: true });
}

// ── Meta ──────────────────────────────────────────────────────────────────

export function readMeta(folder: string, slug: string): AgentMeta | null {
  const metaPath = path.join(entryDir(folder, slug), 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AgentMeta;
  } catch {
    return null;
  }
}

export function writeMeta(folder: string, slug: string, meta: AgentMeta): void {
  const dir = entryDir(folder, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

// ── List ──────────────────────────────────────────────────────────────────

/** Count immediate subdirectories (each is a custom skill). */
function countCustomSkills(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
}

export function listLibrary(folder: string): LibraryEntry[] {
  const root = libraryRoot(folder);
  if (!fs.existsSync(root)) return [];

  const activeSlug = readActiveSlot(folder);
  const entries: LibraryEntry[] = [];

  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const slug = dirent.name;
    const meta = readMeta(folder, slug);
    if (!meta) continue;

    const containerPath = path.join(entryDir(folder, slug), 'container.json');
    let provider = 'claude';
    let model = '';
    let builtinSkills: string[] = [];
    if (fs.existsSync(containerPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(containerPath, 'utf-8')) as {
          provider?: string;
          model?: string;
          skills?: unknown;
        };
        provider = cfg.provider ?? 'claude';
        model = cfg.model ?? '';
        builtinSkills = Array.isArray(cfg.skills) ? (cfg.skills as string[]) : [];
      } catch {
        // malformed — use defaults
      }
    }

    const isActive = slug === activeSlug;
    const isDirty = isActive ? isEntryDirty(folder, slug) : false;

    entries.push({
      slug,
      name: meta.name,
      description: meta.description,
      updatedAt: meta.updatedAt,
      isActive,
      isDirty,
      provider,
      model,
      builtinSkills,
      customSkillCount: countCustomSkills(path.join(entryDir(folder, slug), 'custom-skills')),
    });
  }

  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── File-copy helpers ─────────────────────────────────────────────────────

function copyFileIfExists(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ── Save / Load / Delete ──────────────────────────────────────────────────

/**
 * Snapshot the group's current CLAUDE.md + container.json (+ optionally
 * CLAUDE.local.md + custom-skills/) into `library/<slug>/`.
 * Does NOT touch meta.json — callers write that separately.
 */
export function saveEntry(folder: string, slug: string, includeMemory: boolean): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  const dst = entryDir(folder, slug);
  fs.mkdirSync(dst, { recursive: true });

  copyFileIfExists(path.join(groupDir, 'CLAUDE.md'), path.join(dst, 'CLAUDE.md'));
  copyFileIfExists(path.join(groupDir, 'container.json'), path.join(dst, 'container.json'));

  if (includeMemory) {
    copyFileIfExists(path.join(groupDir, 'CLAUDE.local.md'), path.join(dst, 'CLAUDE.local.md'));
  }

  const customSrc = path.join(groupDir, 'custom-skills');
  if (fs.existsSync(customSrc)) {
    const customDst = path.join(dst, 'custom-skills');
    fs.rmSync(customDst, { recursive: true, force: true });
    copyDirRecursive(customSrc, customDst);
  }
}

/**
 * Restore `library/<slug>/` back to the group root. Updates `.active-slot`.
 * Custom-skills: replaces entirely if the entry has them; leaves existing
 * custom-skills untouched when the entry has none.
 * CLAUDE.local.md: only copied if present in the entry (preserves current
 * memory when the snapshot had no memory).
 */
export function loadEntry(folder: string, slug: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  const src = entryDir(folder, slug);

  copyFileIfExists(path.join(src, 'CLAUDE.md'), path.join(groupDir, 'CLAUDE.md'));
  copyFileIfExists(path.join(src, 'container.json'), path.join(groupDir, 'container.json'));

  const localMdSrc = path.join(src, 'CLAUDE.local.md');
  if (fs.existsSync(localMdSrc)) {
    fs.copyFileSync(localMdSrc, path.join(groupDir, 'CLAUDE.local.md'));
  }

  const customSrc = path.join(src, 'custom-skills');
  if (fs.existsSync(customSrc)) {
    const customDst = path.join(groupDir, 'custom-skills');
    fs.rmSync(customDst, { recursive: true, force: true });
    copyDirRecursive(customSrc, customDst);
  }

  writeActiveSlot(folder, slug);
}

/**
 * Remove `library/<slug>/`. Clears `.active-slot` when the deleted entry
 * was the active one. Returns false when slug not found.
 */
export function deleteEntry(folder: string, slug: string): boolean {
  const dir = entryDir(folder, slug);
  if (!fs.existsSync(dir)) return false;
  // Read active slot before removing the directory.
  const wasActive = readActiveSlot(folder) === slug;
  fs.rmSync(dir, { recursive: true, force: true });
  if (wasActive) clearActiveSlot(folder);
  return true;
}

// ── Phase B: dirty detection ──────────────────────────────────────────────

function computeFileHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Compare the group's live CLAUDE.md + container.json against the stored
 * entry. Returns false when either file is absent (no baseline → not dirty).
 * Called only for the active entry — non-active entries are always clean.
 */
export function isEntryDirty(folder: string, slug: string): boolean {
  const groupDir = path.join(GROUPS_DIR, folder);
  const eDir = entryDir(folder, slug);

  const activeClaude = path.join(groupDir, 'CLAUDE.md');
  const activeContainer = path.join(groupDir, 'container.json');
  const entryClaude = path.join(eDir, 'CLAUDE.md');
  const entryContainer = path.join(eDir, 'container.json');

  if (
    !fs.existsSync(activeClaude) ||
    !fs.existsSync(activeContainer) ||
    !fs.existsSync(entryClaude) ||
    !fs.existsSync(entryContainer)
  ) {
    return false;
  }

  try {
    if (
      computeFileHash(fs.readFileSync(activeClaude, 'utf-8')) !== computeFileHash(fs.readFileSync(entryClaude, 'utf-8'))
    )
      return true;
    if (
      computeFileHash(fs.readFileSync(activeContainer, 'utf-8')) !==
      computeFileHash(fs.readFileSync(entryContainer, 'utf-8'))
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

// ── Phase E: default-agent templates ─────────────────────────────────────

const DEFAULT_AGENTS_DIR = path.join(process.cwd(), 'library', 'default-agents');

/**
 * List read-only default agent templates from `library/default-agents/`.
 * Returns [] when the directory doesn't exist.
 */
export function listDefaultAgents(): LibraryEntry[] {
  if (!fs.existsSync(DEFAULT_AGENTS_DIR)) return [];

  const entries: LibraryEntry[] = [];

  for (const dirent of fs.readdirSync(DEFAULT_AGENTS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const slug = dirent.name;
    const templateDir = path.join(DEFAULT_AGENTS_DIR, slug);

    const metaPath = path.join(templateDir, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta: AgentMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AgentMeta;
    } catch {
      continue;
    }

    const containerPath = path.join(templateDir, 'container.json');
    let provider = 'claude';
    let model = '';
    let builtinSkills: string[] = [];
    if (fs.existsSync(containerPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(containerPath, 'utf-8')) as {
          provider?: string;
          model?: string;
          skills?: unknown;
        };
        provider = cfg.provider ?? 'claude';
        model = cfg.model ?? '';
        builtinSkills = Array.isArray(cfg.skills) ? (cfg.skills as string[]) : [];
      } catch {
        // malformed — use defaults
      }
    }

    entries.push({
      slug,
      name: meta.name,
      description: meta.description,
      updatedAt: meta.updatedAt,
      isActive: false,
      isDirty: false,
      provider,
      model,
      builtinSkills,
      customSkillCount: countCustomSkills(path.join(templateDir, 'custom-skills')),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export { DEFAULT_AGENTS_DIR };

// ── Phase D: provisioning seed ────────────────────────────────────────────

/**
 * Seed `library/initial` from the current group state if the library has
 * no entries yet. Idempotent — no-op when any entry already exists.
 * Called from group-init.ts at group creation time.
 */
export function seedInitialLibraryEntry(folder: string): void {
  const root = libraryRoot(folder);
  if (fs.existsSync(root)) {
    const hasEntries = fs
      .readdirSync(root, { withFileTypes: true })
      .some((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (hasEntries) return;
  }
  // Seed without memory (CLAUDE.local.md is per-session noise at provision time).
  saveEntry(folder, 'initial', false);
  const now = new Date().toISOString();
  writeMeta(folder, 'initial', {
    name: 'Initial agent',
    description: 'Your starting agent — a snapshot from when this workspace was first set up.',
    createdAt: now,
    updatedAt: now,
  });
}
