import { describe, it, expect } from 'vitest';

import { omlxAdapter, STATIC_OMLX } from './omlx.js';

describe('omlx adapter parseId', () => {
  it('passes through arbitrary mlx model ids verbatim', () => {
    const p = omlxAdapter.parseId('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.id).toBe('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.alias).toBe('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.bucket).toBeUndefined();
    expect(p?.rank).toEqual([]);
  });

  it('handles other model name shapes', () => {
    expect(omlxAdapter.parseId('mlx-community/Llama-3.2-3B-Instruct-4bit')?.id).toBe(
      'mlx-community/Llama-3.2-3B-Instruct-4bit',
    );
    expect(omlxAdapter.parseId('phi-3-mini-4k-instruct')?.id).toBe('phi-3-mini-4k-instruct');
  });

  it('never returns null — unlike cloud adapters, we accept anything mlx-omni emits', () => {
    expect(omlxAdapter.parseId('')).not.toBeNull();
    expect(omlxAdapter.parseId('weird id with spaces')).not.toBeNull();
  });
});

describe('omlx adapter pickTop', () => {
  it('sorts alphabetically and slices to maxCount', () => {
    const ids = ['zeta', 'alpha', 'mu', 'beta'];
    const parsed = ids.map((id) => omlxAdapter.parseId(id)).filter((p): p is NonNullable<typeof p> => p !== null);
    const top = omlxAdapter.pickTop(parsed, 3);
    expect(top.map((m) => m.alias)).toEqual(['alpha', 'beta', 'mu']);
  });

  it('does not throw on empty input', () => {
    expect(omlxAdapter.pickTop([], 4)).toEqual([]);
  });
});

describe('omlx adapter metadata', () => {
  it('declares the correct registry identity', () => {
    expect(omlxAdapter.name).toBe('local');
    expect(omlxAdapter.defaultHost).toBe('localhost');
    expect(omlxAdapter.envBaseUrlVar).toBe('OMLX_BASE_URL');
    expect(omlxAdapter.modelsPath).toBe('/v1/models');
  });

  it('staticFallback contains the curated Qwen entry', () => {
    expect(STATIC_OMLX.some((h) => h.id.startsWith('Qwen3.6'))).toBe(true);
  });

  it('noteFor returns undefined (no curated aliases)', () => {
    expect(omlxAdapter.noteFor('anything')).toBeUndefined();
  });
});
