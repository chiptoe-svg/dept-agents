// src/knowledge/pipeline-pdf.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./stages/extract-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stages/extract-text.js')>();
  return {
    ...actual,
    extractPdf: vi.fn().mockResolvedValue('Extracted PDF text from a sample document.'),
  };
});

import { createCorpus, corpusDir, readMeta } from './corpus.js';
import { runTextPipeline } from './pipeline.js';

let tmpFolder: string;

beforeEach(() => {
  tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-pdf-test-'));
});

afterEach(() => {
  fs.rmSync(tmpFolder, { recursive: true, force: true });
});

describe('runTextPipeline — PDF routing', () => {
  it('processes .pdf files via extractPdf and sets status to ready', async () => {
    const { extractPdf } = await import('./stages/extract-text.js');
    const meta = createCorpus(tmpFolder, { name: 'pdf-test', sourceType: 'text' });
    fs.writeFileSync(path.join(corpusDir(tmpFolder, meta.id), 'raw', 'sample.pdf'), Buffer.from('%PDF-1.4 fake'));

    await runTextPipeline(tmpFolder, meta.id);

    const updated = readMeta(tmpFolder, meta.id);
    expect(updated.status).toBe('ready');
    expect(updated.chunkCount).toBeGreaterThan(0);
    expect(vi.mocked(extractPdf)).toHaveBeenCalled();
  });
});
