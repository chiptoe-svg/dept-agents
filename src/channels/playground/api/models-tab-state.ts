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
import { loadUserProviderCreds } from '../../../user-provider-auth.js';
import { getOwnerUserId } from '../../../modules/permissions/db/user-roles.js';
import { listAllForProvider, resetCacheForProvider } from '../../../model-discovery.js';
import { fetchHfMetadata } from '../../../hf-metadata.js';
import { ownerHasCredsForSpec } from '../../../owner-creds-ready.js';
import type { ModelEntry } from '../../../model-catalog.js';

// classPoolReady delegates to the shared owner-creds-ready helper so
// the answer matches the resolver's actual sibling-fallback behavior.
function classPoolReadyForSpec(ownerId: string | null, specId: string): boolean {
  return ownerHasCredsForSpec(specId, ownerId);
}

/**
 * For OMLX (local server) only — augment the static catalog with whatever
 * mlx-omni-server reports at /v1/models right now. Synthesises minimal
 * ModelEntry objects for ids not already in the spec's catalogModels.
 * model-discovery's in-process cache (CACHE_TTL_MS) bounds the rate.
 */
async function omlxLiveCatalog(staticEntries: readonly ModelEntry[]): Promise<ModelEntry[]> {
  let hints: Awaited<ReturnType<typeof listAllForProvider>> = [];
  try {
    hints = await listAllForProvider('local');
  } catch {
    return [];
  }
  const known = new Set(staticEntries.map((e) => e.id));
  const newIds = hints.filter((h) => !known.has(h.id));
  // Parallel HF lookups so we don't serialise N round-trips.
  const enriched = await Promise.all(newIds.map(async (h) => ({ h, hf: await fetchHfMetadata(h.id) })));
  return enriched.map(({ h, hf }) => ({
    id: h.id,
    modelProvider: 'local',
    displayName: h.id,
    origin: 'local',
    costPer1kTokensUsd: 0,
    modalities: hf?.modalities ?? ['text'],
    chips: ['🆓 free', '💻 mlx local', '🔍 discovered'],
    paramCount: hf?.paramCount,
    contextSize: hf?.contextSize,
    notes: hf?.notes ?? h.note ?? 'Discovered live from your mlx-omni-server.',
  }));
}

// Clemson endpoint live-discovery: same shape as OMLX (OpenAI-compatible
// /v1/models), just a different URL and a different bearer token. Direct
// fetch — model-discovery's registry only knows the per-provider adapters
// today and Clemson doesn't have one. Cached per-call by the caller's
// `refreshSpec` semantics; not de-duplicated across concurrent requests.
let clemsonCache: { entries: ModelEntry[]; expiresAt: number } | null = null;
const CLEMSON_CACHE_MS = 60_000;

async function clemsonLiveCatalog(staticEntries: readonly ModelEntry[]): Promise<ModelEntry[]> {
  const now = Date.now();
  if (clemsonCache && clemsonCache.expiresAt > now) return clemsonCache.entries;

  const env = (await import('../../../env.js')).readEnvFile(['CAMPUS_LLM_BASE_URL', 'CAMPUS_LLM_API_KEY']);
  const base = (env.CAMPUS_LLM_BASE_URL || 'https://llm.rcd.clemson.edu').replace(/\/$/, '');
  const key = env.CAMPUS_LLM_API_KEY;
  if (!key) {
    clemsonCache = { entries: [], expiresAt: now + CLEMSON_CACHE_MS };
    return [];
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let ids: string[] = [];
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    }
  } catch {
    /* network blip — return whatever static catalog covers */
  } finally {
    clearTimeout(timer);
  }
  const known = new Set(staticEntries.map((e) => e.id));
  const newIds = ids.filter((id) => !known.has(id));
  const enriched = await Promise.all(newIds.map(async (id) => ({ id, hf: await fetchHfMetadata(id) })));
  const discovered: ModelEntry[] = enriched.map(({ id, hf }) => ({
    id,
    modelProvider: 'clemson',
    displayName: id,
    origin: 'cloud',
    costPer1kTokensUsd: 0,
    modalities: hf?.modalities ?? ['text'],
    chips: ['🏛 Clemson', '🆓 free', '🔍 discovered'],
    paramCount: hf?.paramCount,
    contextSize: hf?.contextSize,
    notes: hf?.notes ?? 'Discovered live from Clemson RCD /v1/models.',
  }));
  clemsonCache = { entries: discovered, expiresAt: now + CLEMSON_CACHE_MS };
  return discovered;
}

/** Test seam / refresh-button cache buster. */
export function resetClemsonCache(): void {
  clemsonCache = null;
}

/**
 * Anthropic live discovery — uses the `claude` model-discovery adapter
 * which hits api.anthropic.com/v1/models with whichever auth header the
 * adapter resolves (host .env, ANTHROPIC_BASE_URL via the credential
 * proxy, etc.). Discovered ids that aren't already in the spec's static
 * catalog get a synthesised entry tagged modelProvider='anthropic'.
 * Static entries (cost-tuned by hand) win on collision.
 */
async function anthropicLiveCatalog(staticEntries: readonly ModelEntry[]): Promise<ModelEntry[]> {
  let hints: Awaited<ReturnType<typeof listAllForProvider>> = [];
  try {
    hints = await listAllForProvider('claude');
  } catch {
    return [];
  }
  const known = new Set(staticEntries.map((e) => e.id));
  return hints
    .filter((h) => !known.has(h.id))
    .map((h) => ({
      id: h.id,
      modelProvider: 'anthropic',
      displayName: h.id,
      origin: 'cloud',
      modalities: ['text'],
      chips: ['☁ Anthropic', '🔍 discovered'],
      notes: h.note || 'Discovered live from api.anthropic.com/v1/models.',
    }));
}

/**
 * OpenAI live discovery via the `codex` model-discovery adapter
 * (api.openai.com/v1/models). The discovered ids belong equally to
 * the `codex` and `openai-platform` proxy routes; the modelProvider
 * tag we write here matches the spec being augmented so the Models
 * tab dedupes correctly within the OpenAI group.
 */
async function openaiLiveCatalog(
  staticEntries: readonly ModelEntry[],
  modelProvider: 'openai-codex' | 'openai-platform',
): Promise<ModelEntry[]> {
  let hints: Awaited<ReturnType<typeof listAllForProvider>> = [];
  try {
    hints = await listAllForProvider('codex');
  } catch {
    return [];
  }
  const known = new Set(staticEntries.map((e) => e.id));
  const sourceLabel = modelProvider === 'openai-codex' ? 'codex' : 'platform';
  return hints
    .filter((h) => !known.has(h.id))
    .map((h) => ({
      id: h.id,
      modelProvider,
      displayName: h.id,
      origin: 'cloud',
      modalities: ['text'],
      chips: ['☁ OpenAI', '🔍 discovered'],
      notes: h.note || `Discovered live from api.openai.com/v1/models (${sourceLabel} route).`,
    }));
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
  /** Bust caches for one spec before computing. Used by the Models tab
   *  per-section refresh button — clears the reachability cache + the
   *  upstream /v1/models discovery cache for that provider. */
  refreshSpec?: string;
}): Promise<{ status: number; body: ModelsTabStateResponse }> {
  const cc = readClassControls();
  const policies = cc.classes[input.classId]?.providers ?? {};
  const specs = listProviderSpecs();
  const ownerId = getOwnerUserId();

  if (input.refreshSpec) {
    reachabilityCache.delete(input.refreshSpec);
    // model-discovery's cache is keyed by adapter name (claude / codex /
    // local). Map specId → adapter name where they differ.
    const SPEC_TO_DISCOVERY: Record<string, string> = {
      claude: 'claude',
      codex: 'codex',
      'openai-platform': 'codex',
      omlx: 'local',
    };
    const adapter = SPEC_TO_DISCOVERY[input.refreshSpec];
    if (adapter) resetCacheForProvider(adapter);
    // Clemson has its own live-fetch cache, not in model-discovery.
    if (input.refreshSpec === 'clemson') resetClemsonCache();
  }

  const providers = await Promise.all(
    specs.map(async (spec) => {
      const policy = policies[spec.id] ?? { allow: false, provideDefault: false, allowByo: false };
      const credsRaw = loadUserProviderCreds(input.userId, spec.id);
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
      // Live-augment catalog for providers with a discoverable /v1/models.
      // Hidden specs skip the query (no creds path → would 401 anyway).
      const staticEntries = spec.catalogModels ?? [];
      let fullCatalog: ModelEntry[] = staticEntries;
      if (derived.state !== 'HIDDEN') {
        if (spec.id === 'omlx') {
          const live = await omlxLiveCatalog(staticEntries);
          fullCatalog = [...staticEntries, ...live];
        } else if (spec.id === 'clemson') {
          const live = await clemsonLiveCatalog(staticEntries);
          fullCatalog = [...staticEntries, ...live];
        } else if (spec.id === 'claude') {
          const live = await anthropicLiveCatalog(staticEntries);
          fullCatalog = [...staticEntries, ...live];
        } else if (spec.id === 'codex') {
          const live = await openaiLiveCatalog(staticEntries, 'openai-codex');
          fullCatalog = [...staticEntries, ...live];
        } else if (spec.id === 'openai-platform') {
          const live = await openaiLiveCatalog(staticEntries, 'openai-platform');
          fullCatalog = [...staticEntries, ...live];
        }
      }
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
        catalogModels: derived.state === 'HIDDEN' ? [] : fullCatalog,
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
      const credsRaw = loadUserProviderCreds(input.userId, spec.id);
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
