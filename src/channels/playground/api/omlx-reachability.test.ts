import { describe, it, expect, vi } from 'vitest';
import { handleOmlxReachability } from './omlx-reachability.js';

// Make sure omlx-spec is registered before the handler queries the registry.
import '../../../providers/omlx-spec.js';

describe('handleOmlxReachability', () => {
  it('returns ok=true when the OMLX server responds 200 (mocked)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await handleOmlxReachability();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(typeof result.body.checkedAt).toBe('string');
    fetchSpy.mockRestore();
  });

  it('returns ok=false on network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await handleOmlxReachability();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    fetchSpy.mockRestore();
  });

  it('busts the reachability cache so the next models-tab-state read re-probes', async () => {
    // The endpoint must invalidate the cache after probing so the next /api/me/models-tab-state
    // call sees the fresh reachability state. Detail: import the cache from models-tab-state
    // and assert the omlx entry is gone after the handler runs.
    const { reachabilityCache } = await import('./models-tab-state.js');
    reachabilityCache.set('omlx', { value: false, expiresAt: Date.now() + 60_000 });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await handleOmlxReachability();
    expect(reachabilityCache.has('omlx')).toBe(false);
    fetchSpy.mockRestore();
  });
});
