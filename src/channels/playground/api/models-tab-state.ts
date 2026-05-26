/**
 * Greying-rule for the Models tab. Pure function: inputs are policy +
 * cred state + reachability, output is the {state, source, actionLabel}
 * triple the frontend renders verbatim.
 *
 * Truth table (precedence top to bottom):
 *   1. !policy.allow                  -> HIDDEN
 *   2. local-only && !reachable       -> GREYED + "test connection"
 *   3. local-only && reachable        -> AVAILABLE + source=local
 *   4. policy.provideDefault          -> AVAILABLE + source=class-pool
 *   5. has personal creds             -> AVAILABLE + source=personal-{oauth|key}
 *   6. policy.allowByo                -> GREYED + "add api key" or "connect"
 *   7. (else)                         -> GREYED + "ask instructor"
 *
 * handleGetModelsTabState composes the pure function with the live
 * class-controls config, per-student credential store, and a 30-second
 * reachability cache.
 */

export type ProviderState = 'AVAILABLE' | 'GREYED' | 'HIDDEN';
export type ProviderSource = 'personal-oauth' | 'personal-key' | 'class-pool' | 'local' | null;

export interface SpecFacts {
  id: string;
  displayName: string;
  catalogModels: Array<{ id: string; modelProvider: string }>;
  hasReachabilityProbe: boolean;
  isLocalOnly: boolean;
  hasOauthMethod: boolean;
  hasApiKeyMethod: boolean;
}

export interface ProviderPolicy {
  allow: boolean;
  provideDefault: boolean;
  allowByo: boolean;
}

export interface CredState {
  hasOAuth: boolean;
  hasApiKey: boolean;
}

export interface DerivedProviderState {
  state: ProviderState;
  source: ProviderSource;
  actionLabel: string | null;
}

export function deriveProviderState(input: {
  spec: SpecFacts;
  policy: ProviderPolicy;
  creds: CredState;
  reachable: boolean;
}): DerivedProviderState {
  const { spec, policy, creds, reachable } = input;

  if (!policy.allow) return { state: 'HIDDEN', source: null, actionLabel: null };

  if (spec.isLocalOnly) {
    if (!reachable) return { state: 'GREYED', source: null, actionLabel: 'test connection' };
    return { state: 'AVAILABLE', source: 'local', actionLabel: 'settings' };
  }

  if (policy.provideDefault) {
    return {
      state: 'AVAILABLE',
      source: 'class-pool',
      actionLabel: policy.allowByo ? 'use my own' : 'manage',
    };
  }

  if (creds.hasOAuth) return { state: 'AVAILABLE', source: 'personal-oauth', actionLabel: 'manage' };
  if (creds.hasApiKey) return { state: 'AVAILABLE', source: 'personal-key', actionLabel: 'manage' };

  if (policy.allowByo) {
    const action = spec.hasOauthMethod ? 'connect' : 'add api key';
    return { state: 'GREYED', source: null, actionLabel: action };
  }

  return { state: 'GREYED', source: null, actionLabel: 'ask instructor' };
}

// ---------------------------------------------------------------------------
// HTTP handler — composes deriveProviderState with live config + cred store
// ---------------------------------------------------------------------------

import { listProviderSpecs } from '../../../providers/auth-registry.js';
import { DEFAULT_CLASS_ID, readClassControls } from './class-controls.js';
import { loadStudentProviderCreds } from '../../../student-provider-auth.js';
import type { ModelEntry } from '../../../model-catalog.js';

const REACHABILITY_CACHE_MS = 30_000;

/** Exported so tests / the future re-test button can bust the cache. */
export const reachabilityCache = new Map<string, { value: boolean; expiresAt: number }>();

async function probeWithCache(specId: string, probe: () => Promise<boolean>): Promise<boolean> {
  const now = Date.now();
  const cached = reachabilityCache.get(specId);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await probe();
  reachabilityCache.set(specId, { value, expiresAt: now + REACHABILITY_CACHE_MS });
  return value;
}

export interface ModelsTabStateResponse {
  providers: Array<{
    id: string;
    displayName: string;
    state: ProviderState;
    source: ProviderSource;
    actionLabel: string | null;
    credentialFileShape: 'oauth-token' | 'api-key' | 'mixed' | 'none';
    catalogModels: ModelEntry[];
  }>;
}

export async function handleGetModelsTabState(input: {
  userId: string;
  agentGroupId: string;
  classId: string;
}): Promise<{ status: number; body: ModelsTabStateResponse }> {
  const cc = readClassControls();
  const policies = cc.classes[input.classId]?.providers ?? {};
  const specs = listProviderSpecs();

  const providers = await Promise.all(
    specs.map(async (spec) => {
      const policy = policies[spec.id] ?? { allow: false, provideDefault: false, allowByo: false };
      const credsRaw = loadStudentProviderCreds(input.userId, spec.id);
      const creds: CredState = credsRaw
        ? { hasOAuth: !!credsRaw.oauth, hasApiKey: !!credsRaw.apiKey }
        : { hasOAuth: false, hasApiKey: false };
      const isLocalOnly = spec.credentialFileShape === 'none';
      const reachable = spec.reachability ? await probeWithCache(spec.id, spec.reachability) : true;
      const facts: SpecFacts = {
        id: spec.id,
        displayName: spec.displayName,
        catalogModels: (spec.catalogModels ?? []).map((m) => ({ id: m.id, modelProvider: m.modelProvider })),
        hasReachabilityProbe: !!spec.reachability,
        isLocalOnly,
        hasOauthMethod: !!spec.oauth,
        hasApiKeyMethod: !!spec.apiKey,
      };
      const derived = deriveProviderState({ spec: facts, policy, creds, reachable });
      return {
        id: spec.id,
        displayName: spec.displayName,
        state: derived.state,
        source: derived.source,
        actionLabel: derived.actionLabel,
        credentialFileShape: spec.credentialFileShape,
        catalogModels: derived.state === 'HIDDEN' ? [] : (spec.catalogModels ?? []),
      };
    }),
  );

  return { status: 200, body: { providers } };
}
