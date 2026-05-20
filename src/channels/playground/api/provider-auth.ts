/**
 * OAuth + API-key HTTP handlers for per-student provider auth (paste-back flow).
 *
 * Routes (registered in playground/server.ts):
 *   GET    /provider-auth/:provider/start      → handleProviderAuthStart
 *                                                returns JSON { authorizeUrl, state, instructions, displayName }
 *   POST   /provider-auth/:provider/exchange   → handleProviderAuthExchange (Task 9)
 *                                                body { code, state }
 *   GET    /api/me/providers/:id               → handleGetProviderStatus (Task 10)
 *   POST   /api/me/providers/:id/api-key       → handlePostApiKey (Task 10)
 *   POST   /api/me/providers/:id/active        → handleSetActive (Task 10)
 *   DELETE /api/me/providers/:id               → handleDisconnect (Task 10)
 *
 * PKCE S256, single-use state tokens via TtlMap. State binds to user_id
 * + providerId + PKCE verifier; exchange enforces single-use via take().
 * Vendor's own redirect_uri (from spec.oauth.redirectUri) is sent unchanged
 * since the vendor OAuth clients are pinned to vendor-controlled URLs —
 * see docs/providers/oauth-endpoints.md.
 */
import crypto from 'crypto';
import { request as httpsRequest } from 'https';

import { getProviderSpec } from '../../../providers/auth-registry.js';
import {
  addApiKey,
  addOAuth,
  clearMethod,
  loadStudentProviderCreds,
  setActiveMethod,
} from '../../../student-provider-auth.js';
import { TtlMap } from '../ttl-map.js';
import type { ApiResult } from './me.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateEntry {
  userId: string;
  providerId: string;
  pkceVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const oauthStateStore = new TtlMap<string, OAuthStateEntry>(STATE_TTL_MS);

export function getOAuthStateStoreForTests(): TtlMap<string, OAuthStateEntry> {
  return oauthStateStore;
}

function randomBase64Url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function handleProviderAuthStart(providerId: string, session: { userId: string }): ApiResult<unknown> {
  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: `unknown provider: ${providerId}` } };
  if (!spec.oauth) return { status: 400, body: { error: `provider ${providerId} has no oauth config` } };

  const state = randomBase64Url(32);
  const pkceVerifier = randomBase64Url(64);
  const codeChallenge = s256(pkceVerifier);

  oauthStateStore.set(state, {
    userId: session.userId,
    providerId,
    pkceVerifier,
    redirectUri: spec.oauth.redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spec.oauth.clientId,
    redirect_uri: spec.oauth.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: spec.oauth.scopes.join(' '),
  });

  return {
    status: 200,
    body: {
      authorizeUrl: `${spec.oauth.authorizeUrl}?${params.toString()}`,
      state,
      instructions: spec.oauth.connectInstructions,
      displayName: spec.displayName,
    },
  };
}

type TokenExchanger = (
  spec: NonNullable<ReturnType<typeof getProviderSpec>>,
  code: string,
  pkceVerifier: string,
  redirectUri: string,
) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number; account?: string } | null>;

let tokenExchanger: TokenExchanger = async (spec, code, pkceVerifier, redirectUri) => {
  if (!spec.oauth) return null;
  // Body format dispatched per provider (smoke-tested 2026-05-17):
  //   Anthropic auth-code grant requires JSON
  //   OpenAI auth-code grant uses standard form-urlencoded
  const payload = {
    grant_type: 'authorization_code',
    code,
    code_verifier: pkceVerifier,
    client_id: spec.oauth.clientId,
    redirect_uri: redirectUri,
  };
  const isJson = spec.oauth.authCodeBodyFormat === 'json';
  const body = isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString();
  const url = new URL(spec.oauth.tokenUrl);
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
            resolve({
              accessToken: json.access_token as string,
              refreshToken: json.refresh_token as string,
              expiresIn: json.expires_in as number,
              account: extractAccountEmail(spec.id, json),
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
};

export function setTokenExchangerForTests(fn: TokenExchanger): void {
  tokenExchanger = fn;
}

/** Extract display-friendly account label per provider.
 *  Anthropic: top-level `account.email_address`.
 *  OpenAI: middle segment of `id_token` JWT, claim `email`.
 *  Both confirmed via smoke test 2026-05-17. */
function extractAccountEmail(providerId: string, tokenResponse: Record<string, unknown>): string | undefined {
  if (providerId === 'claude') {
    const account = tokenResponse.account as { email_address?: string } | undefined;
    return account?.email_address;
  }
  if (providerId === 'codex' && typeof tokenResponse.id_token === 'string') {
    const parts = tokenResponse.id_token.split('.');
    if (parts.length !== 3) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as { email?: string };
      return claims.email;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function handleProviderAuthExchange(
  providerId: string,
  body: { code?: string; state?: string },
  session: { userId: string },
): Promise<ApiResult<unknown>> {
  const code = (body.code ?? '').trim();
  const state = (body.state ?? '').trim();
  if (!code || !state) return { status: 400, body: { error: 'code and state required' } };

  const entry = oauthStateStore.take(state);
  if (!entry) return { status: 400, body: { error: 'invalid or expired state' } };
  if (entry.providerId !== providerId) return { status: 400, body: { error: 'state/provider mismatch' } };
  if (entry.userId !== session.userId) return { status: 403, body: { error: 'state bound to different session' } };

  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: 'unknown provider' } };

  const tokens = await tokenExchanger(spec, code, entry.pkceVerifier, entry.redirectUri);
  if (!tokens) {
    return { status: 502, body: { error: 'token exchange failed' } };
  }

  addOAuth(session.userId, providerId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    account: tokens.account,
  });

  return { status: 200, body: { ok: true, account: tokens.account } };
}

export function handleGetProviderStatus(providerId: string, session: { userId: string }): ApiResult<unknown> {
  const creds = loadStudentProviderCreds(session.userId, providerId);
  if (!creds) return { status: 200, body: { hasApiKey: false, hasOAuth: false, active: null } };
  return {
    status: 200,
    body: {
      hasApiKey: Boolean(creds.apiKey),
      hasOAuth: Boolean(creds.oauth),
      active: creds.active,
      oauth: creds.oauth ? { account: creds.oauth.account } : undefined,
    },
  };
}

export function handlePostApiKey(
  providerId: string,
  body: { apiKey?: string },
  session: { userId: string },
): ApiResult<unknown> {
  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: `unknown provider: ${providerId}` } };
  const apiKey = (body.apiKey ?? '').trim();
  if (!apiKey) return { status: 400, body: { error: 'apiKey required' } };
  if (spec.apiKey?.validatePrefix && !apiKey.startsWith(spec.apiKey.validatePrefix)) {
    return { status: 400, body: { error: `apiKey must start with ${spec.apiKey.validatePrefix}` } };
  }
  addApiKey(session.userId, providerId, apiKey);
  return { status: 200, body: { ok: true } };
}

export function handleSetActive(
  providerId: string,
  body: { active?: 'apiKey' | 'oauth' },
  session: { userId: string },
): ApiResult<unknown> {
  if (!body.active || (body.active !== 'apiKey' && body.active !== 'oauth')) {
    return { status: 400, body: { error: 'active must be apiKey or oauth' } };
  }
  try {
    setActiveMethod(session.userId, providerId, body.active);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}

export function handleDisconnect(
  providerId: string,
  body: { which?: 'apiKey' | 'oauth' },
  session: { userId: string },
): ApiResult<unknown> {
  if (!body.which || (body.which !== 'apiKey' && body.which !== 'oauth')) {
    return { status: 400, body: { error: 'which must be apiKey or oauth' } };
  }
  clearMethod(session.userId, providerId, body.which);
  return { status: 200, body: { ok: true } };
}
