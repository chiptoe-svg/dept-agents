/**
 * HTTP handlers for the per-agent library API.
 *
 * All routes under /api/drafts/:folder/library.
 * Authorization: canReadDraft for all operations — the library is
 * student-owned data, not gated by the class mutation gate.
 *
 * Phase C of docs/superpowers/plans/2026-05-21-agent-library.md
 */
import { getActiveSessions } from '../../../db/sessions.js';
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { isContainerRunning, killContainer } from '../../../container-runner.js';
import { canReadDraft } from '../draft-read-gate.js';
import {
  DEFAULT_AGENTS_DIR,
  deleteEntry,
  entryDir,
  generateSlug,
  libraryRoot,
  listLibrary,
  loadEntry,
  readActiveSlot,
  readMeta,
  saveEntry,
  writeActiveSlot,
  writeMeta,
} from './agent-library.js';
import fs from 'fs';
import path from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Stop any running container for the group so the next message respawns. */
function killGroupContainer(folder: string): void {
  const group = getAgentGroupByFolder(folder);
  if (!group) return;
  for (const s of getActiveSessions()) {
    if (s.agent_group_id !== group.id) continue;
    if (!isContainerRunning(s.id)) continue;
    try {
      killContainer(s.id, 'agent library load');
    } catch {
      /* best-effort */
    }
  }
}

function existingSlugs(folder: string): string[] {
  const root = libraryRoot(folder);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function entryCount(folder: string): number {
  return existingSlugs(folder).length;
}

// ── Handlers ───────────────────────────────────────────────────────────────

export function handleListAgentLibrary(
  folder: string,
  userId: string | null | undefined,
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };
  return {
    status: 200,
    body: { entries: listLibrary(folder), activeSlug: readActiveSlot(folder) },
  };
}

export function handleSaveNew(
  folder: string,
  userId: string | null | undefined,
  body: { name?: unknown; description?: unknown; includeMemory?: unknown },
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (name.length > 64) return { status: 400, body: { error: 'name must be 64 characters or fewer' } };

  const count = entryCount(folder);
  if (count >= 20) return { status: 409, body: { error: 'Library full — delete an agent to continue (max 20)' } };

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const includeMemory = body.includeMemory === true;

  const existing = existingSlugs(folder);
  const slug = generateSlug(name, existing);
  const now = new Date().toISOString();

  try {
    saveEntry(folder, slug, includeMemory);
    writeMeta(folder, slug, { name, description, createdAt: now, updatedAt: now });
    writeActiveSlot(folder, slug);
    return { status: 200, body: { slug } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handleSaveExisting(
  folder: string,
  userId: string | null | undefined,
  slug: string,
  body: { includeMemory?: unknown },
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  const meta = readMeta(folder, slug);
  if (!meta) return { status: 404, body: { error: `Library entry "${slug}" not found` } };

  const includeMemory = body.includeMemory === true;

  try {
    saveEntry(folder, slug, includeMemory);
    writeMeta(folder, slug, { ...meta, updatedAt: new Date().toISOString() });
    writeActiveSlot(folder, slug);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handleLoadEntry(
  folder: string,
  userId: string | null | undefined,
  slug: string,
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  const meta = readMeta(folder, slug);
  if (!meta) return { status: 404, body: { error: `Library entry "${slug}" not found` } };

  try {
    loadEntry(folder, slug);
    killGroupContainer(folder);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handleRenameEntry(
  folder: string,
  userId: string | null | undefined,
  slug: string,
  body: { name?: unknown; description?: unknown },
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  const meta = readMeta(folder, slug);
  if (!meta) return { status: 404, body: { error: `Library entry "${slug}" not found` } };

  const name = typeof body.name === 'string' ? body.name.trim() : meta.name;
  const description = typeof body.description === 'string' ? body.description.trim() : meta.description;

  if (!name) return { status: 400, body: { error: 'name must be non-empty' } };
  if (name.length > 64) return { status: 400, body: { error: 'name must be 64 characters or fewer' } };

  try {
    writeMeta(folder, slug, { ...meta, name, description, updatedAt: new Date().toISOString() });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handleDeleteEntry(
  folder: string,
  userId: string | null | undefined,
  slug: string,
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  // Verify the entry exists first so we return 404 rather than a false
  // "deleted" signal when the slug is unknown.
  if (!fs.existsSync(entryDir(folder, slug))) {
    return { status: 404, body: { error: `Library entry "${slug}" not found` } };
  }

  const deleted = deleteEntry(folder, slug);
  return { status: 200, body: { ok: deleted } };
}

export function handleFromTemplate(
  folder: string,
  userId: string | null | undefined,
  body: { templateSlug?: unknown; name?: unknown; description?: unknown },
): { status: number; body: unknown } {
  if (!canReadDraft(folder, userId)) return { status: 403, body: { error: 'Forbidden' } };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (name.length > 64) return { status: 400, body: { error: 'name must be 64 characters or fewer' } };

  const templateSlug = typeof body.templateSlug === 'string' ? body.templateSlug.trim() : '';
  if (!templateSlug) return { status: 400, body: { error: 'templateSlug is required' } };

  const count = entryCount(folder);
  if (count >= 20) return { status: 409, body: { error: 'Library full — delete an agent to continue (max 20)' } };

  const templateDir = path.join(DEFAULT_AGENTS_DIR, templateSlug);
  if (!fs.existsSync(templateDir)) {
    return { status: 404, body: { error: `Template "${templateSlug}" not found` } };
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const existing = existingSlugs(folder);
  const newSlug = generateSlug(name, existing);
  const now = new Date().toISOString();
  const dst = entryDir(folder, newSlug);

  try {
    fs.mkdirSync(dst, { recursive: true });

    // Copy CLAUDE.md
    const claudeSrc = path.join(templateDir, 'CLAUDE.md');
    if (fs.existsSync(claudeSrc)) fs.copyFileSync(claudeSrc, path.join(dst, 'CLAUDE.md'));

    // Copy container.json
    const containerSrc = path.join(templateDir, 'container.json');
    if (fs.existsSync(containerSrc)) fs.copyFileSync(containerSrc, path.join(dst, 'container.json'));

    // Copy custom-skills/ if present
    const customSrc = path.join(templateDir, 'custom-skills');
    if (fs.existsSync(customSrc)) {
      copyDirRecursive(customSrc, path.join(dst, 'custom-skills'));
    }

    writeMeta(folder, newSlug, { name, description, createdAt: now, updatedAt: now });
    loadEntry(folder, newSlug);
    killGroupContainer(folder);
    return { status: 200, body: { slug: newSlug } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/** Copy a directory recursively — duplicated from agent-library.ts to avoid circular deps. */
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
