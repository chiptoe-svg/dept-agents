/**
 * Google OAuth login for the playground (Phase 2 of plans/classroom-web-multiuser.md).
 *
 * Two endpoints, mounted on the playground HTTP server:
 *   GET /oauth/google/start    — build the consent URL, redirect.
 *   GET /oauth/google/callback — exchange code for tokens, look up the
 *                                asserted email in classroom_roster, mint
 *                                a playground session if the email is
 *                                enrolled, persist the per-student
 *                                refresh_token (Phase 3 fold-in).
 *
 * Uses the GWS OAuth client already configured at
 * `~/.config/gws/credentials.json` (the same client `/add-classroom-gws`
 * sets up). The redirect URI must be registered in GCP Console — that's
 * the one-time per-deployment setup step. Default redirect URI is
 * `http(s)://<public-host>:<port>/oauth/google/callback`; override via
 * `PLAYGROUND_PUBLIC_URL` env var when the playground sits behind a
 * reverse proxy (Caddy, Cloudflare Tunnel).
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { PLAYGROUND_BIND_HOST, PLAYGROUND_PORT } from '../../config.js';
import { lookupRosterByEmail } from '../../db/classroom-roster.js';
import { buildAuthorizationUrl, DEFAULT_GWS_SCOPES, exchangeCodeForTokens, loadOAuthClient } from '../../gws-auth.js';
import { log } from '../../log.js';
import { studentGwsCredentialsPath } from '../../student-creds-paths.js';
import { formatSessionCookie, mintSessionForUser, type PlaygroundSession } from './auth-store.js';
import { escapeHtml, send, sendHtml } from './http-helpers.js';
import { TtlMap } from './ttl-map.js';

// Re-export so existing test + smoke script imports keep working.
export { studentGwsCredentialsPath };

const STATE_TTL_MS = 5 * 60 * 1000;

// Marker type so the TtlMap declaration carries intent. The state token
// itself doesn't need any payload — its presence is the assertion.
interface PendingOAuthState {
  /* intentionally empty */
}

const pendingStates = new TtlMap<string /*state*/, PendingOAuthState>(STATE_TTL_MS);

function detectPublicBase(): string {
  const override = process.env.PLAYGROUND_PUBLIC_URL || process.env.NANOCLAW_PUBLIC_URL;
  if (override) return override.replace(/\/$/, '');
  // PLAYGROUND_BIND_HOST may be 0.0.0.0; use a routable substitute.
  const host =
    PLAYGROUND_BIND_HOST === '0.0.0.0' ? process.env.PLAYGROUND_PUBLIC_HOST || 'localhost' : PLAYGROUND_BIND_HOST;
  return `http://${host}:${PLAYGROUND_PORT}`;
}

function redirectUri(): string {
  return `${detectPublicBase()}/oauth/google/callback`;
}

/**
 * Mint a fresh state token, store it with a 5-min TTL. Returned to the
 * caller for embedding in the OAuth URL; verified when the callback
 * fires.
 */
function mintState(): string {
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, {});
  return state;
}

function consumeState(state: string): boolean {
  return pendingStates.take(state) !== undefined;
}

interface GoogleIdTokenPayload {
  email?: string;
  email_verified?: boolean;
  name?: string;
  sub?: string;
}

/**
 * Decode the payload of a Google id_token (JWT). Signature verification
 * is skipped because the token came directly from `oauth2.googleapis.com`
 * over TLS in our own server-to-server exchange — no third party touched
 * it. If a future caller invokes this on tokens received from clients,
 * verification must be added.
 */
export function decodeGoogleIdToken(idToken: string): GoogleIdTokenPayload | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as GoogleIdTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Persist the freshly-minted refresh token at the per-student credentials
 * path used by Phase 3's per-request proxy lookup. Same shape as
 * `~/.config/gws/credentials.json` so the existing loader works
 * unchanged once the credential proxy learns to consult per-student
 * paths.
 *
 * If the OAuth response omits `refresh_token` (Google sometimes does this
 * on re-consent), we keep whatever refresh_token is already on disk for
 * this student. If neither is present, we throw — the caller surfaces
 * "please re-authenticate".
 */
export function persistStudentGwsCredentials(opts: {
  userId: string;
  clientId: string;
  clientSecret: string;
  tokens: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
}): void {
  const credPath = studentGwsCredentialsPath(opts.userId);
  fs.mkdirSync(path.dirname(credPath), { recursive: true });

  const existing = fs.existsSync(credPath)
    ? (JSON.parse(fs.readFileSync(credPath, 'utf8')) as { refresh_token?: string })
    : {};

  const refreshToken = opts.tokens.refresh_token ?? existing.refresh_token;
  if (!refreshToken) {
    throw new Error(
      `No refresh_token in Google response and none on disk for ${opts.userId}. The consent flow must use prompt=consent and access_type=offline.`,
    );
  }

  const merged = {
    type: 'authorized_user',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: refreshToken,
    access_token: opts.tokens.access_token,
    token_type: opts.tokens.token_type ?? 'Bearer',
    expiry_date: opts.tokens.expires_in ? Date.now() + opts.tokens.expires_in * 1000 : undefined,
    scope: opts.tokens.scope ?? DEFAULT_GWS_SCOPES.join(' '),
  };
  const tmp = `${credPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credPath);
}

// ── HTTP handlers ─────────────────────────────────────────────────────────

export function handleOAuthStart(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/oauth/google/start') return false;

  let client: { client_id: string; client_secret: string };
  try {
    client = loadOAuthClient();
  } catch (err) {
    log.error('Google OAuth start failed: no GWS client configured', { err });
    sendHtml(
      res,
      500,
      '<h1>Google login not configured</h1><p>The instructor needs to run /add-classroom-gws so the OAuth client is on disk.</p>',
    );
    return true;
  }

  const state = mintState();
  const consentUrl = buildAuthorizationUrl({
    clientId: client.client_id,
    redirectUri: redirectUri(),
    state,
    // openid + email lets us learn who's logging in; the other GWS scopes
    // are folded in here (Phase 3) so the same consent screen produces a
    // refresh token usable for Doc/Sheet/Drive operations later.
    scopes: DEFAULT_GWS_SCOPES,
  });

  res.writeHead(302, { location: consentUrl });
  res.end();
  return true;
}

interface CallbackResult {
  status: number;
  contentType: string;
  body: string;
  setCookie?: string;
}

/**
 * Pure-function form of the callback so tests can drive it without
 * wiring a real http.IncomingMessage / Response. The HTTP wrapper below
 * just adapts this to the playground's router.
 */
export async function processOAuthCallback(opts: {
  code: string | null;
  state: string | null;
  exchange?: typeof exchangeCodeForTokens;
}): Promise<CallbackResult> {
  if (!opts.code) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Missing code</h1><p>Google did not return an authorization code.</p>',
    };
  }
  if (!opts.state || !consumeState(opts.state)) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Invalid state</h1><p>The login attempt expired or was tampered with. Try again.</p>',
    };
  }

  let client: { client_id: string; client_secret: string };
  try {
    client = loadOAuthClient();
  } catch {
    return {
      status: 500,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>OAuth client missing</h1>',
    };
  }

  const exchange = opts.exchange ?? exchangeCodeForTokens;
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchange({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code: opts.code,
      redirectUri: redirectUri(),
    });
  } catch (err) {
    log.error('Google token exchange failed', { err });
    return {
      status: 502,
      contentType: 'text/html; charset=utf-8',
      body: `<h1>Token exchange failed</h1><pre>${escapeHtml((err as Error).message)}</pre>`,
    };
  }

  const idToken = tokens.id_token;
  const payload = idToken ? decodeGoogleIdToken(idToken) : null;
  const email = payload?.email;
  if (!email || payload?.email_verified === false) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Email not verified</h1><p>Google did not return a verified email address. Try a different account.</p>',
    };
  }

  const entry = lookupRosterByEmail(email);
  if (!entry) {
    log.warn('Google login: email not on roster', { email });
    return {
      status: 403,
      contentType: 'text/html; charset=utf-8',
      body: `<h1>Not enrolled</h1><p>The email <code>${escapeHtml(email)}</code> isn't on the class roster. Ask your instructor to add you.</p>`,
    };
  }

  // Phase 3 fold-in: persist refresh token per-student so the credential
  // proxy can later inject the *student's* OAuth bearer for Drive/Doc
  // operations instead of always using the instructor's.
  try {
    persistStudentGwsCredentials({
      userId: entry.user_id,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      tokens,
    });
  } catch (err) {
    log.warn('Could not persist per-student GWS credentials', { userId: entry.user_id, err });
    // Non-fatal — the playground session still mints; only Phase 3 is
    // affected. The student can re-do OAuth later to get the per-student
    // proxy lookup working.
  }

  const session: PlaygroundSession = mintSessionForUser(entry.user_id);
  log.info('Google OAuth login succeeded', { userId: entry.user_id, email });

  return {
    status: 302,
    contentType: 'text/plain',
    body: '',
    setCookie: formatSessionCookie(session.cookieValue),
  };
}

export async function handleOAuthCallback(url: URL, res: http.ServerResponse): Promise<boolean> {
  if (url.pathname !== '/oauth/google/callback') return false;
  const result = await processOAuthCallback({
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
  });
  const headers: Record<string, string> = { 'content-type': result.contentType };
  if (result.status === 302) {
    headers.location = '/';
  }
  if (result.setCookie) headers['set-cookie'] = result.setCookie;
  res.writeHead(result.status, headers);
  res.end(result.body);
  return true;
}

/** Test-only: drop the in-memory pending-state map. */
export function _resetOAuthStateForTest(): void {
  pendingStates.clear();
}

/** Test-only: insert a state so callers can drive the callback path. */
export function _seedOAuthStateForTest(state: string, ttlMs = STATE_TTL_MS): void {
  pendingStates.set(state, {}, ttlMs);
}
