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
  /** True when the instructor (owner) actually has class-pool credentials
   *  for this spec OR a sibling spec (e.g. codex ↔ openai-platform share
   *  the same OpenAI API key). When `provideDefault` is on but this is
   *  false, the section greys out instead of falsely showing AVAILABLE.
   *  Undefined = legacy callers; default to true for backward compat. */
  classPoolReady?: boolean;
}): DerivedProviderState {
  const { spec, policy, creds, reachable, classPoolReady } = input;

  if (!policy.allow) return { state: 'HIDDEN', source: null, actionLabel: null };

  if (spec.isLocalOnly) {
    if (!reachable) return { state: 'GREYED', source: null, actionLabel: 'test connection' };
    return { state: 'AVAILABLE', source: 'local', actionLabel: 'settings' };
  }

  // Class pool only counts as AVAILABLE when the instructor actually has
  // creds for the spec (or a sibling that the resolver will fall back on).
  if (policy.provideDefault && classPoolReady !== false) {
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
import { getOwnerUserId } from '../../../modules/permissions/db/user-roles.js';
import type { ModelEntry } from '../../../model-catalog.js';

// Mirrors SIBLING_API_KEY_SPECS in classroom-provider-resolver.ts — when
// the resolver looks up class-pool creds for one OpenAI spec and the
// owner only stored the key under the other, it falls back. Keep the
// two maps in sync.
const CLASS_POOL_SIBLINGS: Record<string, string[]> = {
  codex: ['openai-platform'],
  'openai-platform': ['codex'],
};

function classPoolReadyForSpec(ownerId: string | null, specId: string): boolean {
  if (!ownerId) return false;
  const direct = loadStudentProviderCreds(ownerId, specId);
  if (direct?.apiKey?.value || direct?.oauth?.accessToken) return true;
  for (const sib of CLASS_POOL_SIBLINGS[specId] ?? []) {
    const sibCreds = loadStudentProviderCreds(ownerId, sib);
    if (sibCreds?.apiKey?.value) return true;
  }
  return false;
}

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
    /** spec.apiKey.placeholder — surfaced so the cred-dialog can show the
     *  right hint (e.g. 'sk-…' for openai-platform) without home.js having
     *  to duplicate the spec metadata. */
    apiKeyPlaceholder?: string;
    /** Which auth methods the spec supports (vs. credentialFileShape which
     *  is the high-level shape). Lets home.js pick button labels like
     *  "Add API key" vs "Connect" without re-deriving from shape strings. */
    hasOauthMethod: boolean;
    hasApiKeyMethod: boolean;
    /** Per-student credential state — what's configured for THIS user. The
     *  greying rule uses this to decide AVAILABLE-source; home.js uses it
     *  for active-method toggles and disconnect buttons. */
    creds: {
      hasOAuth: boolean;
      hasApiKey: boolean;
      active?: 'oauth' | 'apiKey';
      accountEmail?: string;
    };
    /** Class Controls policy — instructor's allow/provideDefault/allowByo
     *  for this provider. Home renders different rows based on these. */
    policy: { allow: boolean; provideDefault: boolean; allowByo: boolean };
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
  const ownerId = getOwnerUserId();

  const providers = await Promise.all(
    specs.map(async (spec) => {
      const policy = policies[spec.id] ?? { allow: false, provideDefault: false, allowByo: false };
      const credsRaw = loadStudentProviderCreds(input.userId, spec.id);
      const creds: CredState = credsRaw
        ? { hasOAuth: !!credsRaw.oauth, hasApiKey: !!credsRaw.apiKey }
        : { hasOAuth: false, hasApiKey: false };
      // 'none' shape covers two distinct cases:
      //   - local server (OMLX) — has a reachability probe; AVAILABLE/local
      //   - institutional pool (Clemson) — no probe; falls through to class-pool
      //     via policy.provideDefault like any other pooled provider.
      const isLocalOnly = spec.credentialFileShape === 'none' && !!spec.reachability;
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
      const classPoolReady = classPoolReadyForSpec(ownerId, spec.id);
      const derived = deriveProviderState({ spec: facts, policy, creds, reachable, classPoolReady });
      return {
        id: spec.id,
        displayName: spec.displayName,
        state: derived.state,
        source: derived.source,
        actionLabel: derived.actionLabel,
        credentialFileShape: spec.credentialFileShape,
        apiKeyPlaceholder: spec.apiKey?.placeholder,
        hasOauthMethod: !!spec.oauth,
        hasApiKeyMethod: !!spec.apiKey,
        creds: {
          hasOAuth: creds.hasOAuth,
          hasApiKey: creds.hasApiKey,
          active: credsRaw?.active,
          accountEmail: credsRaw?.oauth?.account,
        },
        policy,
        catalogModels: derived.state === 'HIDDEN' ? [] : (spec.catalogModels ?? []),
      };
    }),
  );

  return { status: 200, body: { providers } };
}

/**
 * Per-spec availability snapshot — same composition as `handleGetModelsTabState`
 * but stripped to `{ [specId]: state === 'AVAILABLE' }`. Used by the Chat tab
 * to filter the provider dropdown to what the student can actually use right
 * now (class policy + personal creds + reachability).
 */
export async function computeProviderAvailability(input: {
  userId: string;
  classId: string;
}): Promise<Record<string, boolean>> {
  const cc = readClassControls();
  const policies = cc.classes[input.classId]?.providers ?? {};
  const specs = listProviderSpecs();
  const ownerId = getOwnerUserId();
  const entries = await Promise.all(
    specs.map(async (spec) => {
      const policy = policies[spec.id] ?? { allow: false, provideDefault: false, allowByo: false };
      const credsRaw = loadStudentProviderCreds(input.userId, spec.id);
      const creds: CredState = credsRaw
        ? { hasOAuth: !!credsRaw.oauth, hasApiKey: !!credsRaw.apiKey }
        : { hasOAuth: false, hasApiKey: false };
      const isLocalOnly = spec.credentialFileShape === 'none' && !!spec.reachability;
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
      const classPoolReady = classPoolReadyForSpec(ownerId, spec.id);
      const derived = deriveProviderState({ spec: facts, policy, creds, reachable, classPoolReady });
      return [spec.id, derived.state === 'AVAILABLE'] as const;
    }),
  );
  return Object.fromEntries(entries);
}
