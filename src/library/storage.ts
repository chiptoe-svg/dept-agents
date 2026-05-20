import fs from 'fs';
import path from 'path';

import { LIBRARY_DIR, STUDENT_LIBRARIES_DIR } from '../config.js';
import type { AllTiers, LibraryEntry, LibraryTier } from './types.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function tierDir(tier: LibraryTier, studentId: string): string {
  if (tier === 'default') return path.join(LIBRARY_DIR, 'default-agents');
  if (tier === 'class') return path.join(LIBRARY_DIR, 'class');
  return path.join(STUDENT_LIBRARIES_DIR, studentId);
}

function readJsonSafe(p: string): LibraryEntry | undefined {
  if (!fs.existsSync(p)) return undefined;
  try {
    const e = JSON.parse(fs.readFileSync(p, 'utf-8')) as LibraryEntry;
    if (typeof e?.name !== 'string') return undefined;
    return e;
  } catch {
    return undefined;
  }
}

function listTier(tier: LibraryTier, studentId: string): LibraryEntry[] {
  const dir = tierDir(tier, studentId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonSafe(path.join(dir, f)))
    .filter((e): e is LibraryEntry => !!e)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listAllTiers(studentId: string): AllTiers {
  return {
    default: listTier('default', studentId),
    class: listTier('class', studentId),
    my: listTier('my', studentId),
  };
}

export function readEntry(tier: LibraryTier, name: string, studentId: string): LibraryEntry | undefined {
  if (!NAME_RE.test(name)) return undefined;
  return readJsonSafe(path.join(tierDir(tier, studentId), `${name}.json`));
}

export function writeMyEntry(studentId: string, name: string, entry: LibraryEntry): void {
  if (!NAME_RE.test(name)) throw new Error('invalid name');
  if (!NAME_RE.test(studentId)) throw new Error('invalid studentId');
  const dir = tierDir('my', studentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ ...entry, name }, null, 2));
}
