/**
 * Live model discovery for the `/model` command.
 *
 * Provider-agnostic. Each provider (Claude, OpenAI/Codex, future Gemini/etc.)
 * is an adapter under `src/model-providers/` that knows its own id format,
 * ranking rules, and auth pattern. This file is the dispatcher: take the
 * provider name from the agent group, look up its adapter, fetch its
 * `/v1/models` endpoint, filter + cap, fall back to static on failure.
 *
 * Custom endpoints are first-class. Each adapter declares its env-var name
 * (e.g. `ANTHROPIC_BASE_URL`); when set, that overrides the adapter's
 * default host. Same convention the credential-proxy uses, so configuring
 * once works for both runtime traffic and model-list discovery.
 *
 * Cache: 1 hour in memory, keyed by provider name. The model list rarely
 * changes; refetching every `/model` invocation would burn rate-limit
 * budget for no gain.
 *
 * Test kill-switch: `NANOCLAW_NO_LIVE_MODELS=1` forces the static path
 * regardless of what auth is configured. Used by unit tests so they don't
 * hit the network.
 */
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { log } from './log.js';
import { getModelProvider, listRegisteredProviders } from './model-providers/index.js';
import { STATIC_CLAUDE } from './model-providers/anthropic.js';
import { STATIC_CODEX } from './model-providers/openai.js';
import type { ModelHint, ParsedModel } from './model-providers/types.js';

export type { ModelHint } from './model-providers/types.js';

const MAX_HINTS = 4;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  hints: ModelHint[];
  all: ModelHint[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// ── Live fetch (provider-agnostic) ─────────────────────────────────────────

interface ModelsApiResponse {
  data?: { id: string }[];
}

interface FetchOpts {
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  protocol: 'http:' | 'https:';
}

function httpGetJson(opts: FetchOpts): Promise<string[] | null> {
  // Local LLM servers (mlx-omni-server, Ollama, LM Studio) run as plain
  // http on the host's loopback. The cloud providers run https. Pick the
  // right transport per resolved upstream.
  const request = opts.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.warn('Model discovery non-200', {
              host: opts.hostname,
              status: res.statusCode,
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as ModelsApiResponse;
            const ids = (json.data ?? []).map((m) => m.id).filter((s): s is string => typeof s === 'string');
            resolve(ids);
          } catch (err) {
            log.warn('Model discovery parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.warn('Model discovery request error', { err: String(err) });
      resolve(null);
    });
    req.end();
  });
}

/**
 * Resolve the host an adapter should call. Reads its declared env-var
 * override (e.g. `OPENAI_BASE_URL`) and parses out hostname + port.
 * Falls back to the adapter's default host on port 443.
 *
 * Custom endpoints might include a path prefix (the credential-proxy uses
 * `http://host:3001/openai/v1` for example). We strip the path here — the
 * adapter declares its own `modelsPath`, and adapters expect to call the
 * upstream host directly, not through the local proxy. Discovery runs on
 * the host where credentials are accessible directly.
 */
function resolveEndpoint(
  envBaseUrlVar: string,
  defaultHost: string,
): { hostname: string; port: number; protocol: 'http:' | 'https:' } {
  const env = readEnvFile([envBaseUrlVar]);
  const raw = env[envBaseUrlVar];
  if (!raw) return { hostname: defaultHost, port: 443, protocol: 'https:' };
  try {
    const u = new URL(raw);
    const protocol = u.protocol === 'http:' ? 'http:' : 'https:';
    return {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : protocol === 'http:' ? 80 : 443,
      protocol,
    };
  } catch {
    log.warn('Invalid base URL env, using default', { envVar: envBaseUrlVar, value: raw });
    return { hostname: defaultHost, port: 443, protocol: 'https:' };
  }
}

/**
 * Result of a live fetch: the curated top-N for the `/model` command and the
 * full parsed list for places that want everything (e.g. the playground
 * Models tab). Both views share the same fetch + parse cost, so we cache
 * them together to avoid double-hitting the provider's `/v1/models`.
 */
interface FetchedModels {
  hints: ModelHint[];
  all: ModelHint[];
}

async function fetchProviderModels(provider: string): Promise<FetchedModels | null> {
  if (process.env.NANOCLAW_NO_LIVE_MODELS) return null;
  const adapter = getModelProvider(provider);
  if (!adapter) return null;
  const auth = adapter.getAuth();
  if (!auth) return null;

  const endpoint = resolveEndpoint(adapter.envBaseUrlVar, adapter.defaultHost);
  const ids = await httpGetJson({
    hostname: endpoint.hostname,
    port: endpoint.port,
    protocol: endpoint.protocol,
    path: adapter.modelsPath,
    headers: { ...(adapter.extraHeaders ?? {}), [auth.name]: auth.value },
  });
  if (!ids || ids.length === 0) return null;

  const parsed: ParsedModel[] = ids.map((id) => adapter.parseId(id)).filter((p): p is ParsedModel => p !== null);
  if (parsed.length === 0) return null;

  const top = adapter.pickTop(parsed, MAX_HINTS);
  const toHint = (p: ParsedModel): ModelHint => ({
    id: p.id,
    alias: p.alias,
    note: adapter.noteFor(p.alias) ?? '',
  });
  return {
    hints: top.map(toHint),
    all: parsed.map(toHint),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

async function loadCached(provider: string | null, force: boolean): Promise<CacheEntry | null> {
  const key = (provider || 'claude').toLowerCase();
  const adapter = getModelProvider(key);
  if (!adapter) return null;

  const now = Date.now();
  if (!force) {
    const cached = cache.get(key);
    if (cached && now < cached.expiresAt) return cached;
  }

  const fetched = await fetchProviderModels(key);
  const entry: CacheEntry = fetched
    ? { hints: fetched.hints, all: fetched.all, expiresAt: now + CACHE_TTL_MS }
    : { hints: adapter.staticFallback, all: adapter.staticFallback, expiresAt: now + CACHE_TTL_MS };
  cache.set(key, entry);
  return entry;
}

export async function hintsForProvider(provider: string | null, force = false): Promise<ModelHint[]> {
  const entry = await loadCached(provider, force);
  return entry?.hints ?? [];
}

/**
 * All discovered models for a provider, no top-N cap. Used by the
 * playground Models tab to show the full available list alongside the
 * curated catalog. Shares the same cache + fetch as `hintsForProvider`.
 */
export async function listAllForProvider(provider: string | null, force = false): Promise<ModelHint[]> {
  const entry = await loadCached(provider, force);
  return entry?.all ?? [];
}

/**
 * Resolve a user-typed alias (`opus`, `5.5`, `5.4mini`) to the full model
 * id sent to the provider. Returns the input unchanged if no alias matches —
 * users can always type the full id directly.
 */
export async function expandAlias(provider: string | null, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const hints = await hintsForProvider(provider);

  // 1. Exact alias match (what was always supported).
  const exact = hints.find((h) => h.alias === trimmed);
  if (exact) return exact.id;

  // 2. Exact id match — typed the full id, accept verbatim.
  const idMatch = hints.find((h) => h.id === trimmed);
  if (idMatch) return idMatch.id;

  // 3. Unique case-insensitive prefix match against the live id list, so
  //    `/model gemma-4` (when only one gemma-4 is loaded) expands to
  //    `gemma-4-31B-it-MLX-4bit`. Crucially, only resolve when the prefix
  //    is *unique* — multiple matches mean the user must disambiguate,
  //    otherwise we'd silently pick the wrong model.
  const lowerInput = trimmed.toLowerCase();
  const prefixMatches = hints.filter((h) => h.id.toLowerCase().startsWith(lowerInput));
  if (prefixMatches.length === 1) return prefixMatches[0].id;

  // 4. No match — return input unchanged. The /model handler and Models-tab
  //    APIs will see the literal string; mlx-omni-server (etc.) then
  //    returns "Model not found" which surfaces to the user instead of
  //    silently storing a broken value.
  return trimmed;
}

/** Internal helper for tests — clears the in-memory cache. */
export function _resetCacheForTest(): void {
  cache.clear();
}

// Static fallback re-exports for tests + any consumer that explicitly wants
// the offline-only path.
export { STATIC_CLAUDE, STATIC_CODEX };

// Re-export adapter introspection for `/model help`-style commands and
// future `/add-admintool-model` skill validation.
export { listRegisteredProviders };
