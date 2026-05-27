import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './clemson-spec.js';

describe('clemson-spec', () => {
  it('registers as id="clemson" with credentialFileShape="none" + no reachability probe', () => {
    const spec = getProviderSpec('clemson');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('none');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeUndefined();
    // No reachability probe — Clemson is institutional pool, not local server.
    // models-tab-state uses (credentialFileShape='none' && hasReachability) to
    // distinguish OMLX (local) from Clemson (class-pool).
    expect(spec!.reachability).toBeUndefined();
  });

  it('ships 11 chat catalog entries with modelProvider="clemson"', () => {
    const spec = getProviderSpec('clemson');
    expect(spec!.catalogModels!.length).toBe(11);
    for (const e of spec!.catalogModels!) {
      expect(e.modelProvider).toBe('clemson');
      expect(e.origin).toBe('cloud');
      // Institution-paid: no per-token billing in this catalog.
      expect(e.costPer1kTokensUsd).toBe(0);
    }
  });

  it('proxyRoutePrefix is /clemson/', () => {
    const spec = getProviderSpec('clemson');
    expect(spec!.proxyRoutePrefix).toBe('/clemson/');
  });
});
