import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts. vi.hoisted runs alongside the mock before any `import`.
const { TMP, fakeEnv } = vi.hoisted(() => {
  return { TMP: '/tmp/nanoclaw-test-websearch-config', fakeEnv: { values: {} as Record<string, string> } };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TMP };
});

// Mock the .env reader so the env-fallback path is deterministic and never
// touches the real .env on disk. process.env still takes priority in the SUT.
vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (fakeEnv.values[k]) out[k] = fakeEnv.values[k];
    return out;
  },
}));

import { readWebSearchProvider, writeWebSearchProvider, readSearxngUrl, readBraveApiKey } from './web-search-config.js';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fakeEnv.values = {};
});
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SEARXNG_URL;
  delete process.env.WEB_SEARCH_API_KEY;
});

describe('web-search config', () => {
  it('defaults to searxng when no file exists', () => {
    expect(readWebSearchProvider()).toBe('searxng');
  });
  it('round-trips a written provider', () => {
    writeWebSearchProvider('brave', 'owner:test');
    expect(readWebSearchProvider()).toBe('brave');
    expect(fs.existsSync(path.join(TMP, 'config', 'web-search.json'))).toBe(true);
  });
  it('falls back to searxng on an unknown stored value', () => {
    fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'config', 'web-search.json'), JSON.stringify({ provider: 'bogus' }));
    expect(readWebSearchProvider()).toBe('searxng');
  });
});

describe('readSearxngUrl / readBraveApiKey (.env reader)', () => {
  it('returns empty when neither process.env nor .env is set', () => {
    expect(readSearxngUrl()).toBe('');
    expect(readBraveApiKey()).toBe('');
  });
  it('reads from .env when process.env is unset', () => {
    fakeEnv.values = { SEARXNG_URL: 'http://192.168.64.1:8888', WEB_SEARCH_API_KEY: 'brave-from-envfile' };
    expect(readSearxngUrl()).toBe('http://192.168.64.1:8888');
    expect(readBraveApiKey()).toBe('brave-from-envfile');
  });
  it('lets process.env override the .env value', () => {
    fakeEnv.values = { SEARXNG_URL: 'http://from-envfile:8888', WEB_SEARCH_API_KEY: 'envfile-key' };
    process.env.SEARXNG_URL = 'http://from-processenv:9999';
    process.env.WEB_SEARCH_API_KEY = 'processenv-key';
    expect(readSearxngUrl()).toBe('http://from-processenv:9999');
    expect(readBraveApiKey()).toBe('processenv-key');
  });
});
