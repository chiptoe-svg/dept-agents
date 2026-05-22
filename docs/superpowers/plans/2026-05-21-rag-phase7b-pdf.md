# Phase 7B-PDF — PDF Source Type

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF as a supported source type in the knowledge pipeline. Students can upload `.pdf` files in the Sources tab; the pipeline extracts text from the binary PDF content using `pdf-parse` and processes it through the existing chunk and BM25 stages.

**Architecture:** Keep `extractText(content: string, filename: string): string` synchronous. Add a parallel async `extractPdf(buffer: Buffer): Promise<string>` in the same file. In `pipeline.ts`, branch on file extension before reading: `.pdf` files are read as `Buffer` and awaited through `extractPdf`; everything else continues as before (utf8 string → `extractText`). This limits the async surface area to the pipeline loop only.

**Tech Stack:** `pdf-parse@2.4.5` (new dep, exact-pinned), `@types/pdf-parse@1.1.5` (new devDep, exact-pinned), existing pipeline infrastructure, vitest (tests via `vi.mock`).

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `pdf-parse@2.4.5` (dep) and `@types/pdf-parse@1.1.5` (devDep) |
| `src/knowledge/stages/extract-text.ts` | Modify | Add `extractPdf(buffer: Buffer): Promise<string>` |
| `src/knowledge/stages/extract-text.test.ts` | Modify | Add tests for `extractPdf` (mocking `pdf-parse`) |
| `src/knowledge/pipeline.ts` | Modify | Branch on `.pdf` extension; read as Buffer + await `extractPdf` |
| `src/knowledge/pipeline.test.ts` | Modify | Add test for PDF file pipeline routing |
| `src/knowledge/types.ts` | Modify | Expand `SourceType` to include `'pdf'` |
| `src/channels/playground/public/tabs/sources.js` | Modify | Add `.pdf` to `accept` attribute on file input |

---

### Task 1: Install `pdf-parse`

**Success criteria:** `pnpm install` completes cleanly; `package.json` shows both packages at their pinned exact versions; lockfile is updated.

- [ ] **Step 1: Add packages to package.json**

Open `package.json`. In the `"dependencies"` object add:
```json
"pdf-parse": "2.4.5"
```
In the `"devDependencies"` object add:
```json
"@types/pdf-parse": "1.1.5"
```

Pin exact versions — no `^` or `~`. Both packages have been on npm for years; no `minimumReleaseAge` issue. Do NOT add either to `onlyBuiltDependencies`.

- [ ] **Step 2: Install**

```bash
cd /Users/admin/projects/nanoclaw && pnpm install
```

Verify both packages appear in `node_modules/pdf-parse` and `node_modules/@types/pdf-parse`.

---

### Task 2: `extractPdf` function and tests

**Files:**
- Modify: `src/knowledge/stages/extract-text.ts`
- Modify: `src/knowledge/stages/extract-text.test.ts`

**Success criteria:** `pnpm test -- extract-text` passes with all existing tests plus the two new PDF tests.

- [ ] **Step 1: Add `extractPdf` to extract-text.ts**

Current file (`src/knowledge/stages/extract-text.ts`):
```typescript
/** Remove script/style blocks, strip HTML tags, decode common entities, collapse whitespace. */
export function stripHtml(html: string): string { ... }

/** Extract plain text from content. Dispatches on file extension. */
export function extractText(content: string, filename: string): string { ... }
```

Add after the existing exports:
```typescript
import pdfParse from 'pdf-parse';

/**
 * Extract plain text from a PDF buffer using pdf-parse.
 * Returns the raw text string from the PDF. Collapses excess whitespace.
 */
export async function extractPdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text.replace(/\s+/g, ' ').trim();
}
```

Note: `pdf-parse` uses a CommonJS default export. The `import pdfParse from 'pdf-parse'` form works with TypeScript's `esModuleInterop` (which this project already uses — verify in `tsconfig.json`). If `esModuleInterop` is absent, use `import * as pdfParse from 'pdf-parse'` and call `pdfParse.default(buffer)` instead.

- [ ] **Step 2: Add tests to extract-text.test.ts**

Use `vi.mock` to avoid needing a real PDF binary in tests:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripHtml, extractText } from './extract-text.js';

// Mock pdf-parse at module level — must be before the dynamic import of extractPdf
vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}));

describe('extractPdf', () => {
  beforeEach(async () => {
    // Import after mock is set up
    const pdfParse = (await import('pdf-parse')).default as ReturnType<typeof vi.fn>;
    pdfParse.mockResolvedValue({ text: '  Hello   PDF world  ' });
  });

  it('returns trimmed text from pdf-parse output', async () => {
    const { extractPdf } = await import('./extract-text.js');
    const buf = Buffer.from('fake-pdf-bytes');
    const result = await extractPdf(buf);
    expect(result).toBe('Hello PDF world');
  });

  it('passes the buffer directly to pdf-parse', async () => {
    const pdfParse = (await import('pdf-parse')).default as ReturnType<typeof vi.fn>;
    const { extractPdf } = await import('./extract-text.js');
    const buf = Buffer.from('another-buffer');
    await extractPdf(buf);
    expect(pdfParse).toHaveBeenCalledWith(buf);
  });
});
```

> **Vitest mock note:** `vi.mock` hoisting means the factory runs before any imports. The `beforeEach` approach with `mockResolvedValue` lets each test control what `pdf-parse` returns. If vitest's module cache causes stale mock state between test runs, add `vi.resetModules()` in `beforeEach` and re-import `extractPdf` inside each test body.

- [ ] **Step 3: Run the test**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- extract-text
```

All existing `stripHtml` and `extractText` tests must still pass. Both new `extractPdf` tests must pass.

---

### Task 3: Update `pipeline.ts` to route PDFs

**File:** `src/knowledge/pipeline.ts`

**Success criteria:** `pnpm test -- pipeline` passes; a `.pdf` file written to `raw/` results in `status: ready` with chunks (using mocked `pdf-parse` in the test, or a real minimal PDF fixture).

- [ ] **Step 1: Update pipeline.ts**

Current relevant section in `runTextPipeline`:
```typescript
for (const file of files) {
  const content = fs.readFileSync(path.join(rawDir, file), 'utf8');
  const text = extractText(content, file);
  ...
}
```

Replace with:
```typescript
import { extractText, extractPdf } from './stages/extract-text.js';

// inside runTextPipeline, inside the for loop:
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
  const chunks =
    meta.chunkStrategy === 'fixed'
      ? chunkFixed(text, id, file)
      : chunkSentence(text, id, file);
  allChunks.push(...chunks);
}
```

The loop body is now `await`-capable because `runTextPipeline` is already `async`. No signature change needed.

Full updated file for clarity:
```typescript
// src/knowledge/pipeline.ts
import fs from 'fs';
import path from 'path';
import { corpusDir, readMeta, updateStatus, writeMeta } from './corpus.js';
import { extractText, extractPdf } from './stages/extract-text.js';
import { chunkSentence, chunkFixed } from './stages/chunk.js';
import { buildBm25Index } from './stages/store-bm25.js';
import type { Chunk } from './types.js';

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
      const chunks =
        meta.chunkStrategy === 'fixed'
          ? chunkFixed(text, id, file)
          : chunkSentence(text, id, file);
      allChunks.push(...chunks);
    }

    // Write chunks.jsonl
    const chunksPath = path.join(dir, 'chunks.jsonl');
    fs.writeFileSync(chunksPath, allChunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

    // Build BM25 index
    buildBm25Index(dir, allChunks);

    meta.status = 'ready';
    meta.chunkCount = allChunks.length;
    writeMeta(folder, id, meta);
  } catch (err) {
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
```

- [ ] **Step 2: Add a pipeline test for PDF routing**

In `src/knowledge/pipeline.test.ts`, add after the existing `runTextPipeline` tests:

```typescript
// At top of file, add:
import { vi } from 'vitest';

vi.mock('../knowledge/stages/extract-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stages/extract-text.js')>();
  return {
    ...actual,
    extractPdf: vi.fn().mockResolvedValue('Extracted PDF text from a sample document.'),
  };
});

// Inside the describe block, add a new test:
it('processes .pdf files via extractPdf and sets status to ready', async () => {
  const { extractPdf } = await import('./stages/extract-text.js');
  const meta = createCorpus(tmpFolder, { name: 'pdf-test', sourceType: 'text' });
  // Write a fake PDF buffer (pdf-parse is mocked, so content doesn't matter)
  fs.writeFileSync(
    path.join(corpusDir(tmpFolder, meta.id), 'raw', 'sample.pdf'),
    Buffer.from('%PDF-1.4 fake')
  );

  await runTextPipeline(tmpFolder, meta.id);

  const updated = readMeta(tmpFolder, meta.id);
  expect(updated.status).toBe('ready');
  expect(updated.chunkCount).toBeGreaterThan(0);
  expect(extractPdf).toHaveBeenCalled();
});
```

> **Alternative if vi.mock causes issues with the existing tests:** place the PDF pipeline test in a separate file `src/knowledge/pipeline-pdf.test.ts` with its own `vi.mock` scope. This avoids polluting the existing test file's module scope.

- [ ] **Step 3: Run the pipeline tests**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test -- pipeline
```

All four existing tests must still pass. The new PDF test must pass.

---

### Task 4: Expand `SourceType` in types.ts

**File:** `src/knowledge/types.ts`

**Success criteria:** TypeScript build passes with no new errors.

- [ ] **Step 1: Add 'pdf' to SourceType**

Current:
```typescript
export type SourceType = 'text';
```

Change to:
```typescript
export type SourceType = 'text' | 'pdf';
```

This is informational — the pipeline currently treats all sourceTypes identically (file extension drives the branch). The type expansion signals to future phases that PDF is a distinct source category.

- [ ] **Step 2: Verify build**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build
```

No new TypeScript errors.

---

### Task 5: Update Sources tab UI

**File:** `src/channels/playground/public/tabs/sources.js`

**Success criteria:** The file input in the browser accepts `.pdf` files.

- [ ] **Step 1: Add .pdf to the accept attribute**

Current (line 36):
```html
<input id="src-file-input" type="file" style="display:none" multiple accept=".txt,.md,.html,.htm">
```

Change to:
```html
<input id="src-file-input" type="file" style="display:none" multiple accept=".txt,.md,.html,.htm,.pdf">
```

No other UI changes are needed. The upload endpoint (`PUT /api/drafts/:folder/knowledge/corpora/:id/upload`) already writes any received buffer to `raw/<filename>` without extension-checking, so PDF uploads will be saved and ingested correctly once the pipeline routes them.

---

### Task 6: Full test suite verification

**Success criteria:** All host tests pass with no regressions.

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/admin/projects/nanoclaw && pnpm test
```

Expected: all existing tests pass, new `extractPdf` tests pass, new pipeline PDF test passes.

- [ ] **Step 2: TypeScript typecheck**

```bash
cd /Users/admin/projects/nanoclaw && pnpm run build
```

Expected: clean compile, no errors.

---

## Notes and Edge Cases

**`pdf-parse` and test environment:** `pdf-parse` does filesystem reads internally (it loads test fixtures from its own package directory on import in some versions). If tests fail with ENOENT errors referencing `pdf-parse/test/data/`, add `vi.mock('pdf-parse', ...)` at the top of any test file that imports `extract-text.ts` directly or indirectly. The factory mock approach in Tasks 2 and 3 avoids this entirely.

**Empty or corrupted PDFs:** `pdf-parse` throws on corrupted input. The existing `try/catch` in `runTextPipeline` catches this and sets `status: 'error'` with the error message — no special handling needed.

**Large PDFs:** `pdf-parse` is synchronous internally (despite returning a Promise); very large PDFs will block the event loop briefly. This is acceptable for the current use case (classroom documents). If this becomes a problem, consider `worker_threads` in a future phase.

**`esModuleInterop` check:** Before running, confirm `tsconfig.json` has `"esModuleInterop": true`. If not, use the `import * as pdfParse from 'pdf-parse'` form and call `pdfParse.default(buffer)` in `extractPdf`. Check with:
```bash
grep esModuleInterop /Users/admin/projects/nanoclaw/tsconfig.json
```

**`handleUploadSource` status code:** The current handler returns `{ status: 200, body: { filename: safe } }` (not 204 as the api-routes caller checks). The api-routes branch for `r.status === 204` is dead code today. This pre-existing inconsistency is out of scope for this plan — do not fix it here.
