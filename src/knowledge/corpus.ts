import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { CorpusMeta, CorpusStatus, SourceType, StoreStrategy } from './types.js';

export function corporaDir(folder: string): string {
  return path.join(folder, 'knowledge', 'corpora');
}

export function corpusDir(folder: string, id: string): string {
  return path.join(corporaDir(folder), id);
}

export function readMeta(folder: string, id: string): CorpusMeta {
  const p = path.join(corpusDir(folder, id), 'meta.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CorpusMeta;
}

export function writeMeta(folder: string, id: string, meta: CorpusMeta): void {
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(corpusDir(folder, id), 'meta.json'), JSON.stringify(meta, null, 2));
}

export function createCorpus(
  folder: string,
  opts: { name: string; sourceType: SourceType; storeStrategy?: StoreStrategy },
): CorpusMeta {
  const id = randomBytes(8).toString('hex');
  const dir = corpusDir(folder, id);
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  const now = new Date().toISOString();
  const meta: CorpusMeta = {
    id,
    name: opts.name,
    sourceType: opts.sourceType,
    chunkStrategy: 'sentence',
    storeStrategy: opts.storeStrategy ?? 'bm25',
    status: 'empty',
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function updateStatus(folder: string, id: string, status: CorpusStatus, errorMessage?: string): void {
  const meta = readMeta(folder, id);
  meta.status = status;
  if (errorMessage !== undefined) meta.errorMessage = errorMessage;
  writeMeta(folder, id, meta);
}

export function listCorpora(folder: string): CorpusMeta[] {
  const dir = corporaDir(folder);
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const metas = ids.flatMap((id) => {
    try {
      return [readMeta(folder, id)];
    } catch {
      return [];
    }
  });
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteCorpus(folder: string, id: string): void {
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
