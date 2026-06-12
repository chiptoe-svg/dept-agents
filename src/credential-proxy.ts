/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to upstream APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Routes by URL path prefix (every provider has an EXPLICIT prefix — there is
 * NO catch-all; an unrecognized/bare path fails closed with 403):
 *   /anthropic/*        → Anthropic API (strip prefix; inject x-api-key / OAuth)
 *   /openai/*           → OpenAI API via ChatGPT/Codex OAuth (strip prefix, inject Authorization)
 *   /openai-platform/*  → OpenAI API via direct Platform API key (strip prefix, inject Authorization)
 *   /omlx/*             → Local OpenAI-compatible server (mlx-omni, Ollama, etc.)
 *                         (strip prefix, inject Bearer OMLX_API_KEY)
 *   /clemson/*          → Clemson RCD-hosted OpenAI-compatible LLM (strip prefix)
 *   /googleapis/*       → Google APIs (currently fenced off by an empty egress
 *                         allowlist — see resolveProxyRoute / EGRESS_ALLOWLIST)
 *   anything else       → 403 (fail closed, no credential injected)
 *
 * Anthropic auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Anthropic OAuth source (in order of priority):
 *   1. CLAUDE_CODE_OAUTH_TOKEN in .env (static, user-managed)
 *   2. ~/.claude/.credentials.json (file written by Claude Code CLI)
 *   3. macOS keychain ("Claude Code-credentials" generic password) — only
 *      consulted on darwin when the file is absent
 *
 * Anthropic OAuth tokens expire (~1 hour). The proxy proactively refreshes
 * them via platform.claude.com/v1/oauth/token before expiry, persists the
 * refreshed token back to the credentials file (so process restarts pick
 * up the latest), and treats unknown expiry (keychain path) as "needs
 * refresh now" so the proxy learns the real expiry time. This makes the
 * proxy self-sufficient — it does NOT rely on Claude CLI running on the
 * same host to keep the file fresh, which is the common case on a Linux
 * server running NanoClaw as a long-lived service.
 *
 * Google OAuth source: ~/.config/gws/credentials.json (authorized_user
 * format with refresh_token). Proxy refreshes the access token on
 * demand and caches it in memory until ~5 min before expiry.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { getGoogleAccessTokenForAgentGroup } from './gws-token.js';
import { log } from './log.js';
import { openStore, type PayloadStore } from './proxy-payload-log/store.js';

/**
 * Per-request credential resolution outcome returned by the
 * userCredsHook. The trunk proxy understands four shapes:
 *   - apiKey / oauth: real creds; proxy injects them
 *   - connect_required: 402 envelope (classroom-skill policy)
 *   - forbidden:       403 envelope (classroom-skill policy)
 *   - null:            no per-student creds; proxy falls through to
 *                      the existing .env / file / keychain chain
 */
export type ResolvedCreds =
  | { kind: 'apiKey'; value: string }
  | { kind: 'oauth'; accessToken: string }
  | { kind: 'connect_required'; provider: string; message: string; connect_url: string }
  | { kind: 'forbidden'; provider: string }
  | null;

export type UserCredsHook = (agentGroupId: string, providerId: string) => Promise<ResolvedCreds>;

/**
 * Trunk default — no-op. Solo installs see this and the proxy falls
 * through to existing .env / file / keychain resolution. The classroom
 * skill calls setUserCredsHook() at startup to install its real
 * resolver.
 */
export let userCredsHook: UserCredsHook = async () => null;

export function setUserCredsHook(fn: UserCredsHook): void {
  userCredsHook = fn;
}

/** Resolve the OMLX upstream auth token. Defaults to literal "godfrey"
 *  so the auth-substitution path is always exercised even on installs
 *  that haven't configured a real key. Override by setting OMLX_API_KEY. */
export function resolveOmlxKey(): string {
  return process.env.OMLX_API_KEY ?? 'godfrey';
}

export type ProxyRoute = 'anthropic' | 'openai' | 'openai-platform' | 'omlx' | 'clemson' | 'googleapis';

/**
 * Map a raw proxy request path to its provider route + the upstream path
 * (prefix stripped). Returns null for the bare path / any unrecognized prefix —
 * there is NO provider catch-all; null callers must fail closed (403).
 */
export function resolveProxyRoute(rawUrl: string): { route: ProxyRoute; upstreamPath: string } | null {
  const prefixes: Array<[ProxyRoute, string]> = [
    ['anthropic', '/anthropic'],
    ['openai-platform', '/openai-platform'],
    ['openai', '/openai'],
    ['omlx', '/omlx'],
    ['clemson', '/clemson'],
    ['googleapis', '/googleapis'],
  ];
  for (const [route, prefix] of prefixes) {
    if (rawUrl === prefix || rawUrl.startsWith(prefix + '/')) {
      return { route, upstreamPath: rawUrl.slice(prefix.length) || '/' };
    }
  }
  return null;
}

/**
 * Per-route upstream-path allowlist. Only these (METHOD, path) pairs are
 * forwarded; everything else → 403 with no credential injected. `googleapis`
 * is intentionally empty — the route is dead (the GWS relay calls Google
 * directly), so it rejects everything. Query strings are ignored.
 *
 * anthropic includes /api/oauth/claude_cli/create_api_key — the OAuth-mode
 * token→temp-key exchange the proxy injects on (see module docstring). Without
 * it, OAuth-mode installs cannot mint a session key and every call fails.
 *
 * Each entry is `"METHOD path"` (single space separator); the path is matched
 * EXACTLY and case-sensitively (no trailing-slash or case normalization) —
 * anything that doesn't match exactly fails closed (403). Paths must not
 * contain leading spaces.
 *
 * A bare prefix like `/anthropic` (no trailing path) resolves to
 * `upstreamPath = '/'`, which is intentionally not in any allowlist, so
 * it 403s.
 */
export const EGRESS_ALLOWLIST: Record<ProxyRoute, string[]> = {
  anthropic: ['POST /v1/messages', 'POST /api/oauth/claude_cli/create_api_key'],
  openai: ['POST /v1/responses', 'POST /v1/chat/completions'],
  'openai-platform': ['POST /v1/responses', 'POST /v1/chat/completions'],
  omlx: ['POST /v1/chat/completions', 'POST /v1/responses'],
  clemson: ['POST /v1/chat/completions', 'POST /v1/responses'],
  googleapis: [],
};

export function isEgressAllowed(route: ProxyRoute, method: string, upstreamPath: string): boolean {
  const pathname = upstreamPath.split('?')[0];
  return EGRESS_ALLOWLIST[route].includes(`${method.toUpperCase()} ${pathname}`);
}

export function serializeResolvedCredsError(
  result: Extract<ResolvedCreds, { kind: 'connect_required' | 'forbidden' }>,
): { status: number; body: Record<string, unknown> } {
  if (result.kind === 'connect_required') {
    return {
      status: 402,
      body: {
        type: 'connect_required',
        provider: result.provider,
        message: result.message,
        connect_url: result.connect_url,
      },
    };
  }
  return {
    status: 403,
    body: { type: 'forbidden', provider: result.provider },
  };
}

/** Header containers send to identify which agent group is calling. */
const AGENT_GROUP_HEADER = 'x-nanoclaw-agent-group';

/** Header containers send to identify the current session (Task 3/4). */
const SESSION_ID_HEADER = 'x-nanoclaw-session-id';

interface PayloadLogCtx {
  baseDir: string;
  stores: Map<string, PayloadStore | null>;
}

// Cap on simultaneously-open payload stores. Each open store holds a
// better-sqlite3 file handle; without a bound the map grows one entry per
// (agentGroup, session) for the process lifetime, leaking FDs across a class
// day. 64 comfortably covers ~14 students × a few concurrent sessions.
const MAX_OPEN_STORES = 64;

function getStore(ctx: PayloadLogCtx, agentGroupId: string, sessionId: string): PayloadStore | null {
  const key = `${agentGroupId}|${sessionId}`;
  if (ctx.stores.has(key)) {
    // Refresh LRU recency: delete + re-set moves the key to the end of the
    // Map's insertion order so it's evicted last.
    const existing = ctx.stores.get(key) ?? null;
    ctx.stores.delete(key);
    ctx.stores.set(key, existing);
    return existing;
  }
  try {
    const s = openStore({ baseDir: ctx.baseDir, agentGroupId, sessionId });
    ctx.stores.set(key, s);
    evictExcessStores(ctx);
    return s;
  } catch (err) {
    log.error('proxy-payload-log: openStore failed (will not retry this session)', { agentGroupId, sessionId, err });
    ctx.stores.set(key, null); // memoize failure
    evictExcessStores(ctx);
    return null;
  }
}

/** Evict the least-recently-used stores (Map insertion order) over the cap, closing each. */
function evictExcessStores(ctx: PayloadLogCtx): void {
  while (ctx.stores.size > MAX_OPEN_STORES) {
    const oldestKey = ctx.stores.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const evicted = ctx.stores.get(oldestKey) ?? null;
    ctx.stores.delete(oldestKey);
    if (evicted) {
      try {
        evicted.close();
      } catch {
        // best-effort close
      }
    }
  }
}

/**
 * OAuth client id used by Claude Code CLI for the refresh-token grant.
 * Matches the value Claude Code itself uses; not a secret.
 */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');

// Buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedOAuthToken: string | null = null;
let cachedExpiresAt = 0;

/**
 * Read the full OAuth credential object (accessToken + refreshToken +
 * expiresAt) from `~/.claude/.credentials.json`, falling back to the
 * macOS keychain when the file is absent.
 *
 * Keychain path is gated by `process.platform === 'darwin'`; on Linux
 * the fallback is a no-op. The keychain entry stores only the access
 * token shape — `expiresAt` is undefined there, which the caller treats
 * as "refresh now" so we learn the real expiry on the first API call.
 */
function readFullOAuthCredentials(): ClaudeCredentials['claudeAiOauth'] | null {
  // Primary: credentials file written by Claude Code CLI
  try {
    if (fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8')) as ClaudeCredentials;
      if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth;
    }
  } catch (err) {
    log.warn('Failed to read Claude credentials file', { err: String(err) });
  }

  // Fallback: macOS keychain. No-op on Linux.
  if (process.platform !== 'darwin') return null;
  try {
    // execFileSync (no shell) + a hard timeout so a locked/busy keychain can't
    // stall the proxy event loop indefinitely. This runs on OAuth refresh, not
    // every request, but under concurrent load an unbounded stall here cascades
    // into SQLite busy-timeouts on the host. 3s ceiling caps the worst case.
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const data = JSON.parse(raw) as ClaudeCredentials;
    if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth;
  } catch {
    // keychain not available, no entry, or timed out — silent fallthrough
  }
  return null;
}

/**
 * Persist refreshed OAuth credentials back to the credentials file so the
 * next process restart picks up the latest token. Best-effort: failure is
 * logged but does not propagate; the in-memory cache is the source of
 * truth for the running process.
 */
function saveOAuthCredentials(updated: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  try {
    let root: Record<string, unknown> = {};
    if (fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
      try {
        root = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8')) as Record<string, unknown>;
      } catch {
        // file unreadable — start fresh; we own the claudeAiOauth field anyway
      }
    } else {
      // Ensure parent dir exists (rare — /home/<user>/.claude is created
      // by the Claude CLI on first run; if it isn't here, create it 0700).
      fs.mkdirSync(path.dirname(CLAUDE_CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
    }
    root.claudeAiOauth = {
      ...((root.claudeAiOauth as object | undefined) ?? {}),
      ...updated,
    };
    const tmp = `${CLAUDE_CREDENTIALS_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH);
  } catch (err) {
    log.warn('Failed to persist refreshed OAuth credentials', { err: String(err) });
  }
}

/**
 * Exchange a refresh token for a new access token via Anthropic's OAuth
 * endpoint. Returns the updated credentials, or null on failure.
 */
function refreshAnthropicOAuthToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString();

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            log.error('Anthropic OAuth refresh failed', {
              status: res.statusCode,
              body: text.slice(0, 500),
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
            if (!json.access_token) {
              log.error('Anthropic OAuth refresh: no access_token in response');
              resolve(null);
              return;
            }
            const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : Date.now() + 60 * 60 * 1000;
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token ?? refreshToken,
              expiresAt,
            });
          } catch (err) {
            log.error('Anthropic OAuth refresh parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.error('Anthropic OAuth refresh request error', { err: String(err) });
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Single-flight refresh guard — multiple concurrent requests that hit a
 * near-expiry condition share one in-flight refresh instead of stampeding
 * the OAuth server.
 */
let refreshInFlight: Promise<void> | null = null;

/**
 * Read the OAuth access token, proactively refreshing when expired or
 * near-expiry. Returns null if no credentials are configured at all.
 *
 * Order of preference:
 *   1. Static `envToken` (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN
 *      from .env) — never refreshed; user manages it.
 *   2. Cached token if not near-expiry.
 *   3. Refreshed token (file → keychain → POST /v1/oauth/token), saved
 *      back to file and cache.
 */
async function getOAuthToken(envToken?: string): Promise<string | null> {
  // Static token from .env always wins.
  if (envToken) return envToken;

  // Cached token still has comfortable headroom — return immediately.
  if (cachedOAuthToken && Date.now() < cachedExpiresAt - REFRESH_BUFFER_MS) {
    return cachedOAuthToken;
  }

  const oauth = readFullOAuthCredentials();
  if (!oauth) return null;

  // Token has time left — adopt it as the cache and return.
  // expiresAt is undefined on the keychain path; treat that as "refresh now"
  // so we learn the real expiry from Anthropic's response.
  if (oauth.expiresAt !== undefined && Date.now() < oauth.expiresAt - REFRESH_BUFFER_MS) {
    cachedOAuthToken = oauth.accessToken;
    cachedExpiresAt = oauth.expiresAt;
    return cachedOAuthToken;
  }

  // Need to refresh. Coalesce concurrent callers behind one in-flight refresh.
  if (!refreshInFlight && oauth.refreshToken) {
    const refreshToken = oauth.refreshToken;
    refreshInFlight = (async () => {
      try {
        const updated = await refreshAnthropicOAuthToken(refreshToken);
        if (updated) {
          cachedOAuthToken = updated.accessToken;
          cachedExpiresAt = updated.expiresAt;
          saveOAuthCredentials(updated);
          log.info('Anthropic OAuth token refreshed', {
            expiresInMin: Math.round((updated.expiresAt - Date.now()) / 60_000),
          });
        }
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  if (refreshInFlight) {
    await refreshInFlight;
  }

  // After refresh attempt: prefer the freshly-cached token; fall back to the
  // pre-refresh access token from the file/keychain (better than null even
  // if it's near-expiry — Anthropic may still accept it for a few minutes).
  return cachedOAuthToken ?? oauth.accessToken ?? null;
}

export function startCredentialProxy(port: number, host = '127.0.0.1', payloadLogBaseDir?: string): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_PLATFORM_API_KEY',
    'OMLX_API_KEY',
    'OMLX_BASE_URL',
    'CAMPUS_LLM_API_KEY',
    'CAMPUS_LLM_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOAuthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const anthropicUpstream = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const openaiUpstream = new URL(secrets.OPENAI_BASE_URL || 'https://api.openai.com');
  const googleUpstream = new URL('https://www.googleapis.com');
  // Local OpenAI-compatible server (mlx-omni-server, Ollama, LM Studio).
  // Routed via the /omlx/* prefix so agents on the `local` provider send
  // codex traffic here while `codex` agents still hit cloud OpenAI.
  const omlxUpstream = new URL(secrets.OMLX_BASE_URL || 'http://localhost:8000');
  // Clemson RCD-hosted LLM endpoint (OpenAI-compatible). Routed via the
  // /clemson/* prefix. Institution-paid, shared across the class pool —
  // no per-student credentials. CAMPUS_LLM_API_KEY substituted on every
  // request that lands on this route.
  const clemsonUpstream = new URL(secrets.CAMPUS_LLM_BASE_URL || 'https://llm.rcd.clemson.edu');

  const requestFor = (isHttps: boolean) => (isHttps ? httpsRequest : httpRequest);

  const payloadLogCtx: PayloadLogCtx | null = payloadLogBaseDir
    ? { baseDir: payloadLogBaseDir, stores: new Map() }
    : null;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // Route by path prefix — every provider is reached by an explicit prefix:
        //   /anthropic/*        → Anthropic API (strip prefix, inject x-api-key or OAuth Bearer)
        //   /openai/*           → OpenAI API via ChatGPT/Codex OAuth (strip prefix, inject Authorization)
        //   /openai-platform/*  → OpenAI API via direct Platform API key (strip prefix, inject Authorization)
        //   /omlx/*             → Local OpenAI-compatible server (strip prefix, inject Bearer OMLX_API_KEY)
        //   /clemson/*          → Clemson RCD-hosted LLM endpoint (strip prefix, inject CAMPUS_LLM_API_KEY)
        //   /googleapis/*       → Google APIs (strip prefix, inject OAuth Bearer) — gated off by empty allowlist in Task 3
        // Unrecognized or bare paths (e.g. /v1/messages without a prefix) fail closed with 403.
        const rawUrl = req.url || '/';
        const resolved = resolveProxyRoute(rawUrl);
        if (!resolved) {
          log.warn('credential-proxy: egress blocked (unrecognized route)', {
            rawUrl,
            src: req.socket.remoteAddress,
          });
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'endpoint not allowed by nanoclaw egress policy' }));
          return;
        }
        const { route, upstreamPath } = resolved;
        const isOpenAIPlatform = route === 'openai-platform';
        const isOpenAI = route === 'openai';
        const isOmlx = route === 'omlx';
        const isClemson = route === 'clemson';
        const isGoogle = route === 'googleapis';
        const isAnthropic = route === 'anthropic';

        // Per-call attribution: which agent group is calling? Used by the
        // per-student GWS resolver below; per-student Anthropic / OpenAI
        // resolvers (Phase 4) will consult the same primitive. Missing
        // header is fine — every resolver gracefully falls back to the
        // class-default credential.
        const rawAgentGroup = req.headers[AGENT_GROUP_HEADER];
        const agentGroupId = typeof rawAgentGroup === 'string' && rawAgentGroup.length > 0 ? rawAgentGroup : null;

        const upstreamUrl = isGoogle
          ? googleUpstream
          : isOpenAI || isOpenAIPlatform
            ? openaiUpstream
            : isOmlx
              ? omlxUpstream
              : isClemson
                ? clemsonUpstream
                : anthropicUpstream; // route === 'anthropic'
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = requestFor(isHttps);

        // `|| 'GET'` is a safe fallback: no allowlist entry uses GET, so a
        // missing method fails closed.
        if (!isEgressAllowed(route, req.method || 'GET', upstreamPath)) {
          log.warn('credential-proxy: egress blocked (path not allowed)', {
            route,
            method: req.method,
            upstreamPath: upstreamPath.split('?')[0],
            src: req.socket.remoteAddress,
          });
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'endpoint not allowed by nanoclaw egress policy' }));
          return;
        }

        // ── payload-log: capture request body ────────────────────────────────
        const rawSessionId = req.headers[SESSION_ID_HEADER];
        const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : 'unattributed';

        let payloadSeq: number | null = null;
        if (payloadLogCtx && agentGroupId) {
          const store = getStore(payloadLogCtx, agentGroupId, sessionId);
          if (store) {
            try {
              payloadSeq = store.write({
                ts: Date.now(),
                upstreamRoute: route,
                upstreamPath,
                body,
              });
            } catch (err) {
              log.error('proxy-payload-log: write failed', { agentGroupId, sessionId, err });
            }
          }
        }
        // ── payload-log end ───────────────────────────────────────────────────

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        // Don't leak the attribution header upstream — it's a NanoClaw-internal hint.
        delete headers[AGENT_GROUP_HEADER];
        // Don't leak the session-id header upstream — it's a NanoClaw-internal hint.
        delete headers[SESSION_ID_HEADER];

        // ── per-user-provider-auth:proxy-invocation START ──────────────────────
        let studentCredsApplied = false;
        if (agentGroupId && (isOpenAI || isOpenAIPlatform || isAnthropic)) {
          // NOTE: 'codex'/'openai-platform'/'claude' here are AUTH provider IDs
          // (matching what codex-spec.ts / openai-platform-spec.ts / claude-spec.ts
          // register in auth-registry.ts), NOT the agent harness provider
          // (agent_groups.agent_provider, now always 'pi').
          // These two namespaces share strings but are independent — do not merge.
          const providerId = isOpenAI ? 'codex' : isOpenAIPlatform ? 'openai-platform' : 'claude';
          const resolved = await userCredsHook(agentGroupId, providerId);
          if (resolved) {
            if (resolved.kind === 'connect_required' || resolved.kind === 'forbidden') {
              const err = serializeResolvedCredsError(resolved);
              res.writeHead(err.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(err.body));
              return;
            }
            delete headers['authorization'];
            delete headers['x-api-key'];
            if (resolved.kind === 'apiKey') {
              if (isOpenAI) headers['authorization'] = `Bearer ${resolved.value}`;
              else headers['x-api-key'] = resolved.value;
            } else {
              headers['authorization'] = `Bearer ${resolved.accessToken}`;
            }
            studentCredsApplied = true;
          }
        }
        // ── per-user-provider-auth:proxy-invocation END ────────────────────────

        // NOTE: unreachable since 2026-06-10 — `/googleapis` has an empty egress
        // allowlist (isEgressAllowed) and 403s above. Kept for a future
        // per-student GWS-through-proxy design, which must add its own controls.
        if (isGoogle) {
          // Google APIs: refresh access token if needed, inject as Bearer.
          // Returns 502 with an actionable message if no creds configured.
          // Per-student token preferred when the agent group has one;
          // instructor / class-default token otherwise.
          const resolved = await getGoogleAccessTokenForAgentGroup(agentGroupId);
          if (!resolved) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    'Google OAuth not configured. Authorize via /add-gmail-tool / /add-gcal-tool (or any flow that writes ~/.config/gws/credentials.json).',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-goog-api-key'];
          headers['authorization'] = `Bearer ${resolved.token}`;
        } else if (isOpenAI && !studentCredsApplied) {
          // OpenAI (ChatGPT/Codex OAuth) mode: replace any placeholder Authorization
          // with the real key. If OPENAI_API_KEY isn't set on the host, 502 with
          // a clear message so the container-side error is actionable.
          if (!secrets.OPENAI_API_KEY) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: 'OPENAI_API_KEY is not set on the host. Add it to .env and restart nanoclaw.',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
        } else if (isOpenAIPlatform && !studentCredsApplied) {
          // OpenAI Platform direct-API mode: inject OPENAI_PLATFORM_API_KEY.
          // Distinct from the /openai/ (Codex/ChatGPT OAuth) route — different
          // key shape and separate cred lookup so they don't conflict.
          if (!secrets.OPENAI_PLATFORM_API_KEY) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: 'OPENAI_PLATFORM_API_KEY is not set on the host. Add it to .env and restart nanoclaw.',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.OPENAI_PLATFORM_API_KEY}`;
          log.info('Credential proxy: injected OPENAI_PLATFORM_API_KEY', { agentGroupId });
        } else if (isOmlx) {
          // Local OpenAI-compatible server. Container sends OPENAI_API_KEY=placeholder
          // or OMLX_API_KEY=placeholder; we replace with OMLX_API_KEY here. Defaults
          // to literal "godfrey" if unset, which keeps the auth-substitution path
          // always exercised even on installs that haven't configured a real key.
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.OMLX_API_KEY || resolveOmlxKey()}`;
        } else if (isClemson) {
          // Clemson RCD-hosted LLM endpoint (OpenAI-compatible). Institution-paid,
          // class-pool only — no per-student creds. Returns 502 if CAMPUS_LLM_API_KEY
          // is not set on the host, so misconfiguration is visible rather than silent.
          if (!secrets.CAMPUS_LLM_API_KEY) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: 'CAMPUS_LLM_API_KEY is not set on the host. Add it to .env and restart nanoclaw.',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.CAMPUS_LLM_API_KEY}`;
        } else if (authMode === 'api-key' && !studentCredsApplied) {
          // Anthropic API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (!studentCredsApplied) {
          // Anthropic OAuth mode: replace placeholder Bearer token with
          // the real one when the container sends an Authorization header.
          // Two distinct use patterns end up here:
          //   1. Claude Code SDK — exchanges OAuth for an API key first
          //      (Authorization header on the exchange call), then uses
          //      the resulting API key via x-api-key on subsequent calls.
          //   2. Direct OAuth (pi-ai with the sk-ant-oat- prefix) — uses
          //      the OAuth token as a Bearer on every call. Anthropic
          //      requires the `anthropic-beta: oauth-2025-04-20` header
          //      for these; without it the API returns "Invalid bearer
          //      token" regardless of token validity. The Claude SDK
          //      already adds this header itself, so unconditionally
          //      forcing it here is a no-op for SDK callers.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = await getOAuthToken(envOAuthToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
              const existingBeta = headers['anthropic-beta'];
              const oauthBeta = 'oauth-2025-04-20';
              if (typeof existingBeta === 'string' && existingBeta.length > 0) {
                if (
                  !existingBeta
                    .split(',')
                    .map((s) => s.trim())
                    .includes(oauthBeta)
                ) {
                  headers['anthropic-beta'] = `${existingBeta},${oauthBeta}`;
                }
              } else if (Array.isArray(existingBeta)) {
                if (!existingBeta.includes(oauthBeta)) {
                  headers['anthropic-beta'] = [...existingBeta, oauthBeta];
                }
              } else {
                headers['anthropic-beta'] = oauthBeta;
              }
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
            // Patch the payload row with the response status once the upstream
            // response has fully arrived. Failures NEVER affect the response.
            upRes.on('end', () => {
              if (payloadSeq != null && payloadLogCtx && agentGroupId) {
                const store = getStore(payloadLogCtx, agentGroupId, sessionId);
                if (store) {
                  try {
                    store.patch(payloadSeq, { responseStatus: upRes.statusCode ?? 0 });
                  } catch (err) {
                    log.error('proxy-payload-log: patch failed', { payloadSeq, err });
                  }
                }
              }
            });
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', {
            err,
            url: req.url,
            route: isGoogle
              ? 'google'
              : isOpenAIPlatform
                ? 'openai-platform'
                : isOpenAI
                  ? 'openai'
                  : isOmlx
                    ? 'omlx'
                    : isClemson
                      ? 'clemson'
                      : 'anthropic',
          });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        // Bound a stalled upstream (TCP half-open, rate-limit queueing) so the
        // container's turn doesn't hang for minutes. 120s covers slow frontier
        // completions while still failing fast on a dead connection.
        upstream.setTimeout(120_000, () => {
          log.warn('Credential proxy upstream timeout — destroying request', { url: req.url });
          upstream.destroy(new Error('upstream timeout'));
        });

        // If the container is killed mid-turn its socket closes; tear down the
        // upstream so we stop consuming API quota and don't leak sockets.
        res.on('close', () => {
          if (!upstream.destroyed) upstream.destroy();
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('close', () => {
      if (payloadLogCtx) {
        // Close all open stores on server shutdown. In-flight responses whose
        // upstreamRes.on('end', ...) listener fires after this will hit a closed-db
        // error, which is caught by the patch try/catch — best-effort shutdown.
        for (const store of payloadLogCtx.stores.values()) {
          if (store) {
            try {
              store.close();
            } catch {
              // best-effort close
            }
          }
        }
      }
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
