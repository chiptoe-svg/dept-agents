import { describe, expect, it, beforeEach } from 'vitest';
import { registerProvider, getProviderSpec, listProviderSpecs, resetRegistryForTests } from './auth-registry.js';
import type { ProviderAuthSpec } from './auth-registry.js';

beforeEach(() => resetRegistryForTests());

describe('auth-registry', () => {
  it('registers and retrieves a provider spec', () => {
    registerProvider({
      id: 'test-prov',
      displayName: 'Test',
      proxyRoutePrefix: '/test/',
      credentialFileShape: 'mixed',
      apiKey: { placeholder: 'tk-…' },
    });
    expect(getProviderSpec('test-prov')?.displayName).toBe('Test');
  });

  it('returns null for unknown providers', () => {
    expect(getProviderSpec('nope')).toBeNull();
  });

  it('lists all registered specs in registration order', () => {
    registerProvider({ id: 'a', displayName: 'A', proxyRoutePrefix: '/a/', credentialFileShape: 'api-key' });
    registerProvider({ id: 'b', displayName: 'B', proxyRoutePrefix: '/b/', credentialFileShape: 'api-key' });
    expect(listProviderSpecs().map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('replacing a provider with the same id overwrites the previous entry', () => {
    registerProvider({ id: 'dup', displayName: 'First', proxyRoutePrefix: '/dup/', credentialFileShape: 'api-key' });
    registerProvider({ id: 'dup', displayName: 'Second', proxyRoutePrefix: '/dup/', credentialFileShape: 'api-key' });
    expect(getProviderSpec('dup')?.displayName).toBe('Second');
    expect(listProviderSpecs()).toHaveLength(1);
  });
});

describe('ProviderAuthSpec extensions', () => {
  it('accepts a spec with catalogModels and returns them via getProviderSpec', () => {
    const spec: ProviderAuthSpec = {
      id: 'test-provider',
      displayName: 'Test Provider',
      proxyRoutePrefix: '/test/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'tk-…' },
      catalogModels: [
        {
          id: 'test-model-1',
          modelProvider: 'test-provider',
          displayName: 'Test Model 1',
          origin: 'cloud',
          costPer1kInUsd: 0.01,
          costPer1kOutUsd: 0.03,
        },
      ],
    };
    registerProvider(spec);
    const fetched = getProviderSpec('test-provider');
    expect(fetched).not.toBeNull();
    expect(fetched!.catalogModels).toHaveLength(1);
    expect(fetched!.catalogModels![0].id).toBe('test-model-1');
  });

  it('accepts a spec with credentialFileShape="none" (no oauth, no apiKey)', () => {
    const spec: ProviderAuthSpec = {
      id: 'local-test',
      displayName: 'Local Test',
      proxyRoutePrefix: '/local-test/',
      credentialFileShape: 'none',
      catalogModels: [],
    };
    registerProvider(spec);
    expect(getProviderSpec('local-test')).not.toBeNull();
  });

  it('accepts a spec with a reachability probe', async () => {
    const spec: ProviderAuthSpec = {
      id: 'local-with-probe',
      displayName: 'Local With Probe',
      proxyRoutePrefix: '/local-test/',
      credentialFileShape: 'none',
      catalogModels: [],
      reachability: async () => true,
    };
    registerProvider(spec);
    const fetched = getProviderSpec('local-with-probe');
    expect(fetched!.reachability).toBeDefined();
    expect(await fetched!.reachability!()).toBe(true);
  });
});
