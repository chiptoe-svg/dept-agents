import { describe, it, expect, beforeEach } from 'vitest';

import {
  STATIC_CLAUDE,
  STATIC_CODEX,
  _resetCacheForTest,
  expandAlias,
  hintsForProvider,
  listRegisteredProviders,
} from './model-discovery.js';

beforeEach(() => {
  _resetCacheForTest();
  // Force the static fallback path so tests don't depend on host credentials.
  process.env.NANOCLAW_NO_LIVE_MODELS = '1';
});

describe('hintsForProvider', () => {
  it('falls back to STATIC_CLAUDE for claude when fetch returns null', async () => {
    const out = await hintsForProvider('claude');
    expect(out).toEqual(STATIC_CLAUDE);
  });

  it('falls back to STATIC_CODEX for codex when fetch returns null', async () => {
    const out = await hintsForProvider('codex');
    expect(out).toEqual(STATIC_CODEX);
  });

  it('returns [] for unknown providers (not registered in adapter registry)', async () => {
    const out = await hintsForProvider('mystery-vendor');
    expect(out).toEqual([]);
  });

  it('returns claude when no provider name is passed', async () => {
    const out = await hintsForProvider(null);
    expect(out).toEqual(STATIC_CLAUDE);
  });

  it('caches the result for the TTL window', async () => {
    const a = await hintsForProvider('claude');
    const b = await hintsForProvider('claude');
    expect(a).toBe(b); // identity equality — second call hit the cache
  });
});

describe('expandAlias', () => {
  it('returns the input if no alias matches', async () => {
    expect(await expandAlias('claude', 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(await expandAlias('claude', 'something-else')).toBe('something-else');
  });

  it('expands a known claude alias to the full id', async () => {
    expect(await expandAlias('claude', 'opus')).toBe(STATIC_CLAUDE[0].id);
  });

  it('expands codex aliases', async () => {
    expect(await expandAlias('codex', '5.5')).toBe('gpt-5.5');
    expect(await expandAlias('codex', '5.4mini')).toBe('gpt-5.4-mini');
  });

  it('trims whitespace before lookup', async () => {
    expect(await expandAlias('codex', '  5.5  ')).toBe('gpt-5.5');
  });
});

describe('listRegisteredProviders', () => {
  it('returns at least claude and codex', () => {
    const names = listRegisteredProviders();
    expect(names).toContain('claude');
    expect(names).toContain('codex');
  });
});
