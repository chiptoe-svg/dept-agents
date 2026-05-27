import { describe, it, expect, vi } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './omlx-spec.js';

describe('omlx-spec', () => {
  it('registers as id="omlx" with credentialFileShape="none"', () => {
    const spec = getProviderSpec('omlx');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('none');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeUndefined();
  });

  it('owns Qwen3.6 catalog entry with modelProvider="local"', () => {
    const spec = getProviderSpec('omlx');
    const ids = spec!.catalogModels!.map((m) => m.id);
    expect(ids).toContain('Qwen3.6-35B-A3B-UD-MLX-4bit');
    for (const e of spec!.catalogModels!) {
      expect(e.modelProvider).toBe('local');
      expect(e.origin).toBe('local');
    }
  });

  it('reachability probe hits /v1/models (mocked)', async () => {
    const spec = getProviderSpec('omlx');
    expect(spec!.reachability).toBeDefined();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const ok = await spec!.reachability!();
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.any(Object));
    fetchSpy.mockRestore();
  });

  it('reachability returns false on network error', async () => {
    const spec = getProviderSpec('omlx');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await spec!.reachability!();
    expect(ok).toBe(false);
    fetchSpy.mockRestore();
  });

  it('reachability probe sends Authorization bearer (defaulting to godfrey)', async () => {
    const spec = getProviderSpec('omlx');
    const originalKey = process.env.OMLX_API_KEY;
    delete process.env.OMLX_API_KEY;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await spec!.reachability!();
    const call = fetchSpy.mock.calls[0];
    const opts = call?.[1] as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.Authorization).toBe('Bearer godfrey');
    fetchSpy.mockRestore();
    if (originalKey !== undefined) process.env.OMLX_API_KEY = originalKey;
  });
});
