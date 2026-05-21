import fs from 'fs';
import path from 'path';
import { canReadDraft, checkDraftMutation } from '../channels/playground/draft-read-gate.js';
import {
  createCorpus,
  corpusDir,
  listCorpora,
  readMeta,
  deleteCorpus,
} from './corpus.js';
import { readChunks, runTextPipeline } from './pipeline.js';
import { queryBm25 } from './stages/store-bm25.js';
import type { SourceType } from './types.js';

type HandlerResult = { status: number; body: unknown };

interface RequestLike {
  headers: Record<string, string>;
}

async function guardRead(folder: string, req: RequestLike): Promise<HandlerResult | null> {
  const token = req.headers['x-playground-token'] ?? '';
  const allowed = await Promise.resolve(canReadDraft(folder, token));
  if (!allowed) return { status: 403, body: { error: 'Forbidden' } };
  return null;
}

async function guardMutate(folder: string, req: RequestLike): Promise<HandlerResult | null> {
  const token = req.headers['x-playground-token'] ?? '';
  const err = await Promise.resolve(checkDraftMutation(folder, token));
  if (err) return { status: 403, body: { error: err } };
  return null;
}

export async function handleListCorpora(
  folder: string,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardRead(folder, req);
  if (deny) return deny;
  return { status: 200, body: { corpora: listCorpora(folder) } };
}

export async function handleCreateCorpus(
  folder: string,
  body: { name?: string; sourceType?: SourceType },
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardMutate(folder, req);
  if (deny) return deny;
  if (!body.name) return { status: 400, body: { error: 'name is required' } };
  const meta = createCorpus(folder, {
    name: body.name,
    sourceType: body.sourceType ?? 'text',
  });
  return { status: 201, body: meta };
}

export async function handleDeleteCorpus(
  folder: string,
  id: string,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardMutate(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  deleteCorpus(folder, id);
  return { status: 204, body: null };
}

export async function handleGetCorpus(
  folder: string,
  id: string,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardRead(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  return { status: 200, body: readMeta(folder, id) };
}

export async function handleUploadSource(
  folder: string,
  id: string,
  filename: string,
  data: Buffer,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardMutate(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  const safe = path.basename(filename);
  fs.writeFileSync(path.join(dir, 'raw', safe), data);
  return { status: 200, body: { filename: safe } };
}

export async function handleIngest(
  folder: string,
  id: string,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardMutate(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  void runTextPipeline(folder, id);
  return { status: 202, body: { message: 'Ingestion started' } };
}

export async function handleInspect(
  folder: string,
  id: string,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardRead(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  const chunks = readChunks(folder, id);
  const meta = readMeta(folder, id);
  return { status: 200, body: { meta, chunks } };
}

export async function handleQuery(
  folder: string,
  id: string,
  query: string,
  k: number,
  req: RequestLike
): Promise<HandlerResult> {
  const deny = await guardRead(folder, req);
  if (deny) return deny;
  const dir = corpusDir(folder, id);
  if (!fs.existsSync(dir)) return { status: 404, body: { error: 'Corpus not found' } };
  const results = queryBm25(dir, query, k);
  return { status: 200, body: { results } };
}
