/**
 * Per-student Google OAuth resource-authorization flow.
 *
 * Two endpoints, to be mounted on the playground HTTP server (Task A.4):
 *   GET /google-auth/start    — require a session cookie, build the consent
 *                               URL, redirect. Binds the state token to the
 *                               session's userId so the callback can resolve
 *                               who's connecting.
 *   GET /google-auth/callback — verify state + session cookie match, exchange
 *                               the authorization code, write per-student
 *                               credentials, stamp agent_group metadata, then
 *                               redirect to /playground/?google_connected=1.
 *
 * Structural differences from the PIN-flow (google-oauth.ts):
 *  - /start requires a session cookie — this flow assumes the student is
 *    already authenticated (PIN sign-in happened first).
 *  - State token carries the userId so the callback has a tamper-proof
 *    binding between the consent interaction and the student who initiated it.
 *  - Callback enforces session.userId === state.userId (defense-in-depth
 *    against cookie substitution mid-flow).
 *  - Persistence uses writeStudentCredentials (Task A.1) rather than
 *    persistStudentGwsCredentials (the PIN-flow helper) — single source
 *    of truth for the writer logic.
 *  - Callback stamps agent_groups.metadata.student_user_id so the per-student
 *    GWS resolver (gws-token.ts) can find this student going forward.
 *
 * The redirect URI must be registered in GCP Console:
 *   <PUBLIC_PLAYGROUND_URL>/google-auth/callback
 *
 * Uses PLAYGROUND_PUBLIC_URL env var when set, falling back to
 * http://<PLAYGROUND_BIND_HOST>:<PLAYGROUND_PORT> for local dev —
 * the same logic as google-oauth.ts's detectPublicBase().
 */
import crypto from 'crypto';
import http from 'http';

import { PLAYGROUND_BIND_HOST, PLAYGROUND_PORT } from '../../../config.js';
import { setAgentGroupMetadataKey } from '../../../db/agent-groups.js';
import { lookupRosterByUserId } from '../../../db/classroom-roster.js';
import {
  buildAuthorizationUrl,
  DEFAULT_GWS_SCOPES,
  exchangeCodeForTokens,
  loadOAuthClient,
  type GwsCredentialsJson,
} from '../../../gws-auth.js';
import { log } from '../../../log.js';
import { loadStudentCredentials, writeStudentCredentials } from '../../../student-google-auth.js';
import { COOKIE_NAME, getSessionByCookie } from '../auth-store.js';
import { escapeHtml, parseCookie, sendHtml } from '../http-helpers.js';
import { TtlMap } from '../ttl-map.js';

// ── State token ────────────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60 * 1000;

interface PendingGoogleAuthState {
  userId: string;
}

const pendingStates = new TtlMap<string /*state*/, PendingGoogleAuthState>(STATE_TTL_MS);

function mintState(userId: string): string {
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, { userId });
  return state;
}

function consumeState(state: string): PendingGoogleAuthState | undefined {
  return pendingStates.take(state);
}

// ── redirectUri ────────────────────────────────────────────────────────────

function detectPublicBase(): string {
  const override = process.env.PLAYGROUND_PUBLIC_URL || process.env.NANOCLAW_PUBLIC_URL;
  if (override) return override.replace(/\/$/, '');
  const host =
    PLAYGROUND_BIND_HOST === '0.0.0.0' ? process.env.PLAYGROUND_PUBLIC_HOST || 'localhost' : PLAYGROUND_BIND_HOST;
  return `http://${host}:${PLAYGROUND_PORT}`;
}

function googleAuthRedirectUri(): string {
  return `${detectPublicBase()}/google-auth/callback`;
}

// ── Handler results ────────────────────────────────────────────────────────

interface HandlerResult {
  status: number;
  contentType: string;
  body: string;
  location?: string;
  /** If set the HTTP adapter sends this as Set-Cookie (not needed here). */
  setCookie?: string;
}

// ── /google-auth/start ─────────────────────────────────────────────────────

/**
 * GET /google-auth/start
 *
 * Requires: a valid session cookie (student must already be signed in via
 * PIN flow or previous Google OAuth). Redirects unauthenticated requests
 * to /login.
 */
export async function handleGoogleAuthStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/google-auth/start') return false;

  // Require an authenticated session.
  const cookieValue = parseCookie(req.headers['cookie'], COOKIE_NAME);
  const session = cookieValue ? getSessionByCookie(cookieValue) : null;
  if (!session || !session.userId) {
    res.writeHead(302, { location: '/login' });
    res.end();
    return true;
  }

  const { userId } = session;

  // Load the OAuth client. Surface a friendly error if it's not configured.
  let client: { client_id: string; client_secret: string };
  try {
    client = loadOAuthClient();
  } catch (err) {
    log.error('google-auth/start: no GWS OAuth client configured', { err });
    sendHtml(
      res,
      500,
      '<h1>Google login not configured</h1>' +
        '<p>The instructor needs to run /add-classroom-gws so the OAuth client is on disk.</p>',
    );
    return true;
  }

  const state = mintState(userId);
  const consentUrl = buildAuthorizationUrl({
    clientId: client.client_id,
    redirectUri: googleAuthRedirectUri(),
    state,
    scopes: DEFAULT_GWS_SCOPES,
  });

  res.writeHead(302, { location: consentUrl });
  res.end();
  return true;
}

// ── processGoogleAuthCallback (pure; injectable for tests) ─────────────────

export async function processGoogleAuthCallback(opts: {
  code: string | null;
  state: string | null;
  error: string | null;
  sessionUserId: string | null;
  exchange?: typeof exchangeCodeForTokens;
}): Promise<HandlerResult> {
  // User denied consent — Google redirects back with ?error=access_denied.
  if (opts.error) {
    return {
      status: 302,
      contentType: 'text/plain',
      body: '',
      location: '/playground/?google_auth_error=denied',
    };
  }

  // Validate state — must exist and carry a userId.
  if (!opts.state) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Missing state</h1><p>The OAuth callback is missing the state parameter. Please start the connection flow again.</p>',
    };
  }

  const stateEntry = consumeState(opts.state);
  if (!stateEntry) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Invalid or expired state</h1><p>The connection attempt expired or was tampered with. Please try again.</p>',
    };
  }

  // Defense-in-depth: session userId must match the state's userId.
  if (!opts.sessionUserId || opts.sessionUserId !== stateEntry.userId) {
    log.warn('google-auth/callback: session userId does not match state userId', {
      sessionUserId: opts.sessionUserId,
      stateUserId: stateEntry.userId,
    });
    return {
      status: 403,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Session mismatch</h1><p>The session used to initiate this connection does not match the one completing it. Please sign in and try again.</p>',
    };
  }

  const userId = stateEntry.userId;

  if (!opts.code) {
    return {
      status: 400,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Missing authorization code</h1><p>Google did not return an authorization code. Please try again.</p>',
    };
  }

  // Load OAuth client.
  let client: { client_id: string; client_secret: string };
  try {
    client = loadOAuthClient();
  } catch (err) {
    log.error('google-auth/callback: no GWS OAuth client configured', { err });
    return {
      status: 500,
      contentType: 'text/html; charset=utf-8',
      body: '<h1>OAuth client missing</h1><p>The GWS OAuth client is not configured on this host.</p>',
    };
  }

  // Exchange the authorization code for tokens.
  const exchange = opts.exchange ?? exchangeCodeForTokens;
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    tokens = await exchange({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code: opts.code,
      redirectUri: googleAuthRedirectUri(),
    });
  } catch (err) {
    log.error('google-auth/callback: token exchange failed', { userId, err });
    return {
      status: 502,
      contentType: 'text/html; charset=utf-8',
      body: `<h1>Token exchange failed</h1><pre>${escapeHtml((err as Error).message)}</pre>`,
    };
  }

  // Resolve the refresh_token: prefer the fresh one; fall back to existing
  // on-disk value (Google sometimes omits refresh_token on re-consent).
  let refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    const existing = loadStudentCredentials(userId);
    refreshToken = existing?.refresh_token;
  }
  if (!refreshToken) {
    return {
      status: 500,
      contentType: 'text/html; charset=utf-8',
      body:
        '<h1>No refresh_token</h1>' +
        '<p>Google did not return a refresh_token and none exists on disk for this student. ' +
        'The consent flow must use <code>prompt=consent</code> and <code>access_type=offline</code>.</p>',
    };
  }

  // Build and write the GwsCredentialsJson.
  const creds: GwsCredentialsJson = {
    type: 'authorized_user',
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: refreshToken,
    access_token: tokens.access_token,
    token_type: tokens.token_type ?? 'Bearer',
    expiry_date: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? DEFAULT_GWS_SCOPES.join(' '),
  };

  try {
    writeStudentCredentials(userId, creds);
  } catch (err) {
    log.error('google-auth/callback: failed to write student credentials', { userId, err });
    return {
      status: 500,
      contentType: 'text/html; charset=utf-8',
      body: `<h1>Failed to save credentials</h1><pre>${escapeHtml((err as Error).message)}</pre>`,
    };
  }

  // Stamp the agent_group's metadata so the per-student GWS resolver can
  // find this student. Look up agent_group_id from the classroom_roster.
  const rosterEntry = lookupRosterByUserId(userId);
  if (rosterEntry?.agent_group_id) {
    try {
      setAgentGroupMetadataKey(rosterEntry.agent_group_id, 'student_user_id', userId);
      log.debug('google-auth/callback: stamped student_user_id on agent group', {
        userId,
        agentGroupId: rosterEntry.agent_group_id,
      });
    } catch (err) {
      // Non-fatal — credentials are already written; only the token resolver
      // is affected until the next time metadata is stamped by another path.
      log.warn('google-auth/callback: failed to stamp agent group metadata', { userId, err });
    }
  } else {
    log.warn('google-auth/callback: no agent_group_id on roster entry — skipping metadata stamp', { userId });
  }

  log.info('google-auth/callback: per-student Google account connected', { userId });

  return {
    status: 302,
    contentType: 'text/plain',
    body: '',
    location: '/playground/?google_connected=1',
  };
}

// ── /google-auth/callback HTTP wrapper ────────────────────────────────────

export async function handleGoogleAuthCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/google-auth/callback') return false;

  // Resolve the session's userId (pass null if unauthenticated — the pure
  // function handles the mismatch → 403).
  const cookieValue = parseCookie(req.headers['cookie'], COOKIE_NAME);
  const session = cookieValue ? getSessionByCookie(cookieValue) : null;

  const result = await processGoogleAuthCallback({
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
    sessionUserId: session?.userId ?? null,
  });

  const headers: Record<string, string> = { 'content-type': result.contentType };
  if (result.location) headers.location = result.location;
  res.writeHead(result.status, headers);
  res.end(result.body);
  return true;
}

// ── Test hooks ─────────────────────────────────────────────────────────────

/** Test-only: drop the in-memory pending-state map. */
export function _resetForTest(): void {
  pendingStates.clear();
}

/** Test-only: insert a state bound to a userId for callback path tests. */
export function _seedStateForTest(state: string, userId: string, ttlMs = STATE_TTL_MS): void {
  pendingStates.set(state, { userId }, ttlMs);
}
