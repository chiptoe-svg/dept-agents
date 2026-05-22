import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { BenchmarkMeta } from './types.js';

function benchmarksDir(folder: string): string {
  return path.join(folder, 'knowledge', 'benchmarks');
}

function benchmarkDir(folder: string, id: string): string {
  return path.join(benchmarksDir(folder), id);
}

export function createBenchmark(folder: string, opts: { name: string; corpusId: string }): BenchmarkMeta {
  const id = randomBytes(8).toString('hex');
  const dir = benchmarkDir(folder, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: BenchmarkMeta = {
    id,
    name: opts.name,
    corpusId: opts.corpusId,
    queries: [],
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function readBenchmark(folder: string, id: string): BenchmarkMeta {
  const p = path.join(benchmarkDir(folder, id), 'meta.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BenchmarkMeta;
}

export function writeBenchmark(folder: string, meta: BenchmarkMeta): void {
  meta.updatedAt = new Date().toISOString();
  const p = path.join(benchmarkDir(folder, meta.id), 'meta.json');
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

export function listBenchmarks(folder: string): BenchmarkMeta[] {
  const dir = benchmarksDir(folder);
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const metas = ids.flatMap((id) => {
    try {
      return [readBenchmark(folder, id)];
    } catch {
      return [];
    }
  });
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBenchmark(folder: string, id: string): void {
  const dir = benchmarkDir(folder, id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
