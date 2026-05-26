import { describe, it, expect } from 'vitest';
import { deriveProviderState } from './models-tab-state.js';
import type { SpecFacts } from './models-tab-state.js';

const baseSpec: SpecFacts = {
  id: 'test',
  displayName: 'Test',
  catalogModels: [],
  hasReachabilityProbe: false,
  isLocalOnly: false,
  hasOauthMethod: false,
  hasApiKeyMethod: true,
};

const allow = { allow: true, provideDefault: false, allowByo: false };
const noCreds = { hasOAuth: false, hasApiKey: false };
const ownOauth = { hasOAuth: true, hasApiKey: false };

describe('deriveProviderState — truth table', () => {
  it('HIDDEN when policy.allow=false', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allow: false },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('HIDDEN');
  });

  it('GREYED + "test connection" when local-only and unreachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow,
      creds: noCreds,
      reachable: false,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('test connection');
  });

  it('AVAILABLE (source local) when local-only and reachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow,
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('local');
  });

  it('AVAILABLE (source class-pool) when provideDefault=true', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, provideDefault: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('class-pool');
  });

  it('AVAILABLE (source personal-oauth) when student has OAuth', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allowByo: true },
      creds: ownOauth,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('personal-oauth');
  });

  it('GREYED + "add api key" when allowByo=true and no creds and apiKey method', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allowByo: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('add api key');
  });

  it('GREYED + "connect" when allowByo=true, oauth method, no creds', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasOauthMethod: true, hasApiKeyMethod: false },
      policy: { ...allow, allowByo: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('connect');
  });

  it('GREYED + "ask instructor" when allow=true but no fallbacks', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: allow,
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('ask instructor');
  });
});
