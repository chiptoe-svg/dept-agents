import { listAllTiers, readEntry, writeMyEntry } from '../../../library/storage.js';
import type { AllTiers, LibraryEntry, LibraryTier } from '../../../library/types.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

const VALID_TIERS: LibraryTier[] = ['default', 'class', 'my'];

/**
 * PlaygroundSession.userId is "<channel>:<handle>" (e.g. "telegram:42").
 * Library storage's NAME_RE rejects colons, so we sanitize at the API
 * boundary. Double-underscore is uniquely reversible: channel prefixes
 * are alphanumeric, handles don't contain `__`, so the mapping
 * `<channel>:<handle>` ↔ `<channel>__<handle>` is bijective in practice.
 */
function sanitizeStudentId(userId: string): string {
  return userId.replace(/:/g, '__');
}

export function handleListLibrary(userId: string): ApiResult<AllTiers> {
  try {
    return { status: 200, body: listAllTiers(sanitizeStudentId(userId)) };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handleGetEntry(tier: string, name: string, userId: string): ApiResult<LibraryEntry> {
  if (!VALID_TIERS.includes(tier as LibraryTier)) {
    return { status: 400, body: { error: 'invalid tier' } };
  }
  const entry = readEntry(tier as LibraryTier, name, sanitizeStudentId(userId));
  if (!entry) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: entry };
}

export function handleSaveMyEntry(userId: string, name: string, entry: LibraryEntry): ApiResult<{ ok: true }> {
  if (typeof entry?.persona !== 'string') {
    return { status: 400, body: { error: 'entry.persona (string) required' } };
  }
  try {
    writeMyEntry(sanitizeStudentId(userId), name, entry);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}
