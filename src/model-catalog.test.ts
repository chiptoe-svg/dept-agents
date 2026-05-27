import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getModelCatalog', () => {
  let tmp: string;
  let localPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    localPath = path.join(tmp, 'local.json');
    vi.doMock('./config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./config.js')>();
      return { ...actual, MODEL_CATALOG_LOCAL_PATH: localPath };
    });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns the bundled entries when local file is empty', async () => {
    fs.writeFileSync(localPath, '[]');
    const { getModelCatalog } = await import('./model-catalog.js');
    const catalog = getModelCatalog();
    // Anthropic entries now assembled via getBuiltinEntries() from claude-spec.ts (mptab-4).
    expect(catalog.find((e) => e.id === 'claude-haiku-4-5')).toBeTruthy();
    expect(catalog.find((e) => e.id === 'claude-sonnet-4-6')).toBeTruthy();
    expect(catalog.find((e) => e.id === 'Qwen3.6-35B-A3B-UD-MLX-4bit')).toBeTruthy();
  });

  it('appends local entries from the JSON file', async () => {
    fs.writeFileSync(
      localPath,
      JSON.stringify([
        {
          id: 'llama-3.3-70b-instruct',
          provider: 'ollama',
          displayName: 'llama-3.3-70b-instruct',
          origin: 'local',
          host: 'http://192.168.1.42:11434',
          contextSize: 32768,
          quantization: 'Q4_K_M',
          paramCount: '70B',
          modalities: ['text'],
          notes: 'Best for short factual queries.',
        },
      ]),
    );
    const { getModelCatalog } = await import('./model-catalog.js');
    const local = getModelCatalog().filter((e) => e.origin === 'local');
    expect(local).toHaveLength(2);
    expect(local.find((e) => e.id === 'llama-3.3-70b-instruct')).toBeTruthy();
    expect(local.find((e) => e.id === 'Qwen3.6-35B-A3B-UD-MLX-4bit')).toBeTruthy();
  });

  it('includes builtin local entries when file does not exist', async () => {
    // localPath intentionally not created
    const { getModelCatalog } = await import('./model-catalog.js');
    const local = getModelCatalog().filter((e) => e.origin === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]!.id).toBe('Qwen3.6-35B-A3B-UD-MLX-4bit');
  });
});

// Side-effect imports register specs into the auth registry before the suite below runs.
import './providers/claude-spec.js';
import './providers/codex-spec.js';
import { getBuiltinEntries } from './model-catalog.js';

describe('model-catalog BUILTIN_ENTRIES assembly', () => {
  it('includes entries from claude-spec', () => {
    const ids = getBuiltinEntries().map((e) => e.id);
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('includes entries from codex-spec', () => {
    const ids = getBuiltinEntries().map((e) => e.id);
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.4-mini');
  });

  it('has no duplicate (modelProvider, id) pairs', () => {
    const seen = new Set<string>();
    for (const e of getBuiltinEntries()) {
      const key = `${e.modelProvider}:${e.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
