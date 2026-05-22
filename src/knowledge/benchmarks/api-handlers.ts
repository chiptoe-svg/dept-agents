import fs from 'fs';
import { corpusDir } from '../corpus.js';
import { createBenchmark, deleteBenchmark, listBenchmarks, readBenchmark, writeBenchmark } from './store.js';
import { runBenchmark } from './runner.js';
import type { BenchmarkQuery } from './types.js';

type HandlerResult = { status: number; body: unknown };

export async function handleListBenchmarks(folder: string): Promise<HandlerResult> {
  return { status: 200, body: { benchmarks: listBenchmarks(folder) } };
}

export async function handleCreateBenchmark(
  folder: string,
  body: { name?: string; corpusId?: string },
): Promise<HandlerResult> {
  if (!body.name) return { status: 400, body: { error: 'name is required' } };
  if (!body.corpusId) return { status: 400, body: { error: 'corpusId is required' } };
  const meta = createBenchmark(folder, { name: body.name, corpusId: body.corpusId });
  return { status: 201, body: meta };
}

export async function handleGetBenchmark(folder: string, id: string): Promise<HandlerResult> {
  try {
    const meta = readBenchmark(folder, id);
    return { status: 200, body: meta };
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
}

export async function handleUpdateBenchmark(
  folder: string,
  id: string,
  body: { name?: string; queries?: BenchmarkQuery[] },
): Promise<HandlerResult> {
  try {
    const meta = readBenchmark(folder, id);
    if (body.name !== undefined) meta.name = body.name;
    if (body.queries !== undefined) meta.queries = body.queries;
    writeBenchmark(folder, meta);
    return { status: 200, body: meta };
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
}

export async function handleDeleteBenchmark(folder: string, id: string): Promise<HandlerResult> {
  try {
    readBenchmark(folder, id);
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
  deleteBenchmark(folder, id);
  return { status: 204, body: null };
}

export async function handleRunBenchmark(folder: string, id: string, k: number): Promise<HandlerResult> {
  let meta;
  try {
    meta = readBenchmark(folder, id);
  } catch {
    return { status: 404, body: { error: 'Benchmark not found' } };
  }
  const dir = corpusDir(folder, meta.corpusId);
  if (!fs.existsSync(dir)) {
    return { status: 404, body: { error: 'Corpus not found' } };
  }
  const result = await runBenchmark(dir, meta, k);
  return { status: 200, body: result };
}
