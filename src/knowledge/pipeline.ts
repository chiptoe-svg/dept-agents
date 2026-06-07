import fs from 'fs';
import path from 'path';
import { log } from '../log.js';
import { corpusDir, readMeta, updateStatus, writeMeta } from './corpus.js';
import { extractText, extractPdf } from './stages/extract-text.js';
import { chunkSentence, chunkFixed } from './stages/chunk.js';
import { buildBm25Index } from './stages/store-bm25.js';
import { embedChunks } from './stages/embed.js';
import { buildDenseIndex } from './stages/store-dense.js';
import type { Chunk } from './types.js';

const PROXY_BASE_URL = process.env.CREDENTIAL_PROXY_URL ?? 'http://localhost:3001';

export async function runTextPipeline(folder: string, id: string): Promise<void> {
  const dir = corpusDir(folder, id);
  try {
    updateStatus(folder, id, 'ingesting');
    const rawDir = path.join(dir, 'raw');
    const files = fs.readdirSync(rawDir).filter((f) => !f.startsWith('.'));
    if (files.length === 0) {
      updateStatus(folder, id, 'error', 'No source files found in raw/');
      return;
    }

    const meta = readMeta(folder, id);
    const allChunks: Chunk[] = [];

    for (const file of files) {
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      let text: string;
      if (ext === 'pdf') {
        const buffer = fs.readFileSync(path.join(rawDir, file));
        text = await extractPdf(buffer);
      } else {
        const content = fs.readFileSync(path.join(rawDir, file), 'utf8');
        text = extractText(content, file);
      }
      const chunks = meta.chunkStrategy === 'fixed' ? chunkFixed(text, id, file) : chunkSentence(text, id, file);
      allChunks.push(...chunks);
    }

    const chunksPath = path.join(dir, 'chunks.jsonl');
    fs.writeFileSync(chunksPath, allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

    if (meta.storeStrategy === 'bm25' || meta.storeStrategy === 'hybrid') {
      buildBm25Index(dir, allChunks);
    }

    if (meta.storeStrategy === 'dense' || meta.storeStrategy === 'hybrid') {
      const embeddings = await embedChunks(allChunks, PROXY_BASE_URL);
      buildDenseIndex(dir, allChunks, embeddings);
    }

    meta.status = 'ready';
    meta.chunkCount = allChunks.length;
    writeMeta(folder, id, meta);
  } catch (err) {
    // Surface the failure in the host log — otherwise a corpus silently goes
    // to 'error' status with only a stringified message in a metadata file,
    // and the instructor has no signal a student's ingest died.
    log.error('knowledge pipeline failed', { folder, id, err });
    try {
      updateStatus(folder, id, 'error', String(err));
    } catch {
      // best-effort; ignore if filesystem is unavailable
    }
  }
}

export function readChunks(folder: string, id: string): Chunk[] {
  const p = path.join(corpusDir(folder, id), 'chunks.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Chunk);
}
