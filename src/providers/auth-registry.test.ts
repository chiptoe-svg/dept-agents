import { describe, expect, it, beforeEach } from 'vitest';
import { registerProvider, getProviderSpec, listProviderSpecs, resetRegistryForTests } from './auth-registry.js';

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
