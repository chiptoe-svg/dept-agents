/**
 * Playground HTTP server lifecycle + request dispatch.
 *
 * `startPlaygroundServer` lazily binds the port (host doesn't open one
 * until /playground is sent on Telegram or the OAuth callback fires);
 * `stopPlaygroundServer` revokes everyone and closes the listener.
 *
 * `handleRequest` is the dispatch entry point:
 *   - Public endpoints (/auth, /oauth/google/start, /oauth/google/callback,
 *     /login) bypass the cookie check.
 *   - HTML page paths get a friendlier 302 → /login on auth miss; XHR
 *     and asset paths get 401 so client code sees the real error.
 *   - Authed requests fall through to static-asset routes (home page +
 *     workbench under /playground/) or the API router in
 *     `api-routes.ts`.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { PLAYGROUND_AUTH_BYPASS, PLAYGROUND_BIND_HOST, PLAYGROUND_ENABLED, PLAYGROUND_PORT } from '../../config.js';
import { log } from '../../log.js';
import { route } from './api-routes.js';
import { getSetupConfig } from './adapter.js';
import {
  COOKIE_NAME,
  createSessionFromMagicToken,
  formatSessionCookie,
  getSessionByCookie,
  hasLostLinkRecoverer,
  isPinRequiredForClassToken,
  mintMagicToken,
  type PlaygroundSession,
  recoverLostLink,
  redeemClassToken,
  revokeAllSessions,
  startIdleSweep,
  stopIdleSweep,
  mintSessionForUser,
} from './auth-store.js';
import { handleIssue as handleLoginPinIssue, handleVerify as handleLoginPinVerify } from './api/login-pin.js';
import { handleGoogleAuthCallback, handleGoogleAuthStart } from './api/google-auth.js';
import { handleOAuthCallback, handleOAuthStart } from './google-oauth.js';
import { parseCookie, readJsonBody, send } from './http-helpers.js';
import { readEnvFile } from '../../env.js';
import { getOwners } from '../../modules/permissions/db/user-roles.js';
// ── class-enrollment-passcode:imports START ────────────────────────────────
import { handleGetClassPasscode, handleRotateClassPasscode, handleEnroll } from './api/enrollment.js';
// ── class-enrollment-passcode:imports END ──────────────────────────────────

// ── classroom-provider-auth:imports START ──────────────────────────────────
import {
  handleProviderAuthStart,
  handleProviderAuthExchange,
  handleGetProviderStatus,
  handlePostApiKey,
  handleSetActive,
  handleDisconnect,
} from './api/provider-auth.js';
// ── classroom-provider-auth:imports END ────────────────────────────────────

let server: http.Server | null = null;

// ── Auth bypass (PLAYGROUND_AUTH_BYPASS=1) ─────────────────────────────────
// Seat is carried in the URL (?seat=<folder>), not in a cookie, so multiple
// browser tabs can each hold a different seat simultaneously.

import { readSeatsConfig } from './seats-config.js';

let _bypassSession: PlaygroundSession | null = null;
function getBypassSession(): PlaygroundSession {
  if (!_bypassSession || !getSessionByCookie(_bypassSession.cookieValue)) {
    const ownerUserId = getOwners()[0]?.user_id ?? null;
    _bypassSession = mintSessionForUser(ownerUserId);
    log.warn('Playground auth bypass active. Set PLAYGROUND_AUTH_BYPASS=0 before go-live.');
  }
  return _bypassSession;
}

// Public assets live under src/ regardless of whether tsc has copied them
// into dist/. cwd is always the project root for both `node dist/index.js`
// (systemd) and `pnpm run dev` (tsx).
const PUBLIC_DIR = path.join(process.cwd(), 'src/channels/playground/public');

interface ServerStatus {
  running: boolean;
  url: string | null;
}

export function getPlaygroundStatus(): ServerStatus {
  return { running: server !== null, url: server !== null ? `http://localhost:${PLAYGROUND_PORT}/` : null };
}

function isPrivateIPv4(addr: string): boolean {
  return (
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr) ||
    addr.startsWith('169.254.') ||
    addr === '127.0.0.1'
  );
}

/**
 * Pick a sensible IPv4 to advertise in the magic-link URL when bound to
 * 0.0.0.0. Prefer:
 *   1. PLAYGROUND_PUBLIC_HOST env override (user knows best)
 *   2. First non-loopback, non-private IPv4 (the public address)
 *   3. First non-loopback IPv4 (e.g. private LAN)
 *   4. 'localhost' as last resort
 */
function detectPublicHost(): string {
  const override = process.env.PLAYGROUND_PUBLIC_HOST;
  if (override) return override;

  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  const publicIp = candidates.find((c) => !isPrivateIPv4(c));
  if (publicIp) return publicIp;
  if (candidates.length > 0) return candidates[0]!;
  return 'localhost';
}

function urlFor(host: string, key: string): string {
  // When bound to 0.0.0.0 we need to advertise an IP browsers can reach.
  // Otherwise (loopback or specific bind), just echo it.
  const display = host === '0.0.0.0' ? detectPublicHost() : host;
  return `http://${display}:${PLAYGROUND_PORT}/auth?key=${encodeURIComponent(key)}`;
}

export async function startPlaygroundServer(
  opts: { userId?: string | null } = {},
): Promise<{ url: string; alreadyRunning: boolean }> {
  if (!PLAYGROUND_ENABLED) {
    throw new Error(
      'PLAYGROUND_ENABLED is not set in env. Add PLAYGROUND_ENABLED=1 to .env or systemd unit and restart.',
    );
  }
  // Mint a fresh single-use magic token bound to the requesting user.
  // Existing sessions from earlier /playground invocations stay valid —
  // we no longer rotate the global cookie out from under other users.
  const token = mintMagicToken(opts.userId ?? null);

  if (server) {
    return { url: urlFor(PLAYGROUND_BIND_HOST, token), alreadyRunning: true };
  }
  if (!getSetupConfig()) {
    throw new Error('Playground adapter setup() was never called — host startup may have failed to register channels.');
  }

  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => handleRequest(req, res));
    httpServer.on('error', (err) => {
      log.error('Playground server error', { err });
      reject(err);
    });
    httpServer.listen(PLAYGROUND_PORT, PLAYGROUND_BIND_HOST, () => {
      server = httpServer;
      startIdleSweep();
      const url = urlFor(PLAYGROUND_BIND_HOST, token);
      log.info('Playground server started', { bind: PLAYGROUND_BIND_HOST, authMode: 'magic-link' });
      resolve({ url, alreadyRunning: false });
    });
  });
}

export async function stopPlaygroundServer(): Promise<void> {
  // Clear all session state defensively even if the listener is gone.
  revokeAllSessions('server-stop');
  stopIdleSweep();
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  log.info('Playground server stopped');
}

// ── Request routing ────────────────────────────────────────────────────────

/**
 * Auth model:
 *   - GET /auth?key=<magic>  — single-shot exchange. Consumes the magic
 *     token (5-min TTL, single-use), mints a new cookie + session row,
 *     redirects to /. Existing sessions are untouched.
 *   - All other endpoints require a cookie matching a row in `sessions`.
 *
 * /playground stop wipes all sessions ("kick everyone"); /playground stop
 * --self only revokes the caller's session via revokeSessionsForUser.
 */
function handleAuthExchange(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/auth') return false;
  const submittedKey = url.searchParams.get('key') || '';
  const session = createSessionFromMagicToken(submittedKey);
  if (!session) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Invalid or expired magic link. Re-send /playground on Telegram.\n');
    return true;
  }
  res.writeHead(302, { location: '/playground/', 'set-cookie': formatSessionCookie(session.cookieValue) });
  res.end();
  return true;
}

/**
 * Class-login token redemption — `GET /?token=<class-token>`. Lets
 * students bookmark a per-roster URL minted by `scripts/class-skeleton.ts`
 * and reach the home page without going through Google OAuth.
 *
 * The actual lookup happens in a classroom-installed module that
 * registers a redeemer via `registerClassTokenRedeemer`. Trunk doesn't
 * know about class tokens — if no redeemer is registered, this is a
 * no-op and the request flows through the normal auth check.
 */
function handleClassTokenRedemption(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/') return false;
  const token = url.searchParams.get('token');
  if (!token) return false;
  // >>> classroom-pin:redirect START — installed by /add-classroom-pin
  // When PIN-2FA is wired, defer cookie minting to /login/pin (the PIN
  // verify endpoint mints the session after the student enters the code).
  if (isPinRequiredForClassToken()) {
    res.writeHead(302, { location: `/login/pin?token=${encodeURIComponent(token)}` });
    res.end();
    return true;
  }
  // <<< classroom-pin:redirect END
  const session = redeemClassToken(token);
  if (!session) return false; // not a class token — let normal auth flow handle the request
  // classroom-pin:redirect START
  // When /add-classroom-pin is installed, the trunk redeemer still resolves
  // the user_id (verifies token is valid + not revoked), but we redirect
  // through the email-PIN entry page instead of setting the cookie now.
  // The PIN page issues a code via Resend and only sets the cookie after
  // the user enters it. This closes the URL-forwarding gap.
  if (isPinRequiredForClassToken()) {
    res.writeHead(302, { location: `/login/pin?token=${encodeURIComponent(token)}` });
    res.end();
    return true;
  }
  // classroom-pin:redirect END
  res.writeHead(302, { location: '/playground/', 'set-cookie': formatSessionCookie(session.cookieValue) });
  res.end();
  return true;
}

/**
 * "Lost your link?" recovery — students who forgot their class-login
 * URL enter their email and a fresh URL is emailed via the registered
 * recoverer (classroom branch's class-login-tokens.ts, wired to Resend).
 *
 * Anti-enumeration: the response is identical for "email on roster" and
 * "email not on roster" — both return ok:true with a generic message.
 * The recoverer must not throw on miss; it should just log and return.
 *
 * When no recoverer is registered (classroom not installed), the
 * response includes a hint pointing the student at their instructor.
 */
async function handleLostLinkRecover(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { email?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    send(res, 200, { ok: true, message: "If we have you on file, you'll receive a fresh link shortly." });
    return;
  }
  if (!hasLostLinkRecoverer()) {
    send(res, 200, {
      ok: true,
      message: 'Self-serve recovery is not enabled here. Please contact your instructor for a fresh login link.',
    });
    return;
  }
  // Fire-and-forget the actual recovery: the response stays generic regardless of outcome.
  recoverLostLink(email).catch((err) => log.error('Lost-link recover handler error', { err: String(err) }));
  send(res, 200, { ok: true, message: "If we have you on file, you'll receive a fresh link shortly." });
}

function authenticate(req: http.IncomingMessage): PlaygroundSession | null {
  const submitted = parseCookie(req.headers['cookie'], COOKIE_NAME);
  if (!submitted) return null;
  return getSessionByCookie(submitted);
}

/**
 * GET requests for an HTML page that the user might be visiting cold
 * (no cookie yet) get a friendlier 302 → /login than a stark 401. XHR /
 * asset requests still 401 so client code sees the real error.
 */
function isHtmlPagePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/playground' ||
    pathname === '/playground/' ||
    pathname === '/playground/index.html'
  );
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';

  // BENCH_MODE auth bypass — only active when BENCH_MODE=1 is set in .env or process.env.
  // Mints a fresh anonymous session and returns it as a Set-Cookie header.
  // Never enabled in production; the env var is only set by operators running the bench suite.
  if (method === 'GET' && url.pathname === '/api/bench/session') {
    const benchMode = process.env.BENCH_MODE ?? readEnvFile(['BENCH_MODE']).BENCH_MODE;
    if (benchMode === '1') {
      // Mint session as the owner so the bench script can read SSE streams
      // and mutate draft configs (checkDraftMutation + canReadDraft both
      // require a non-null userId that has owner/admin/member access).
      const ownerUserId = getOwners()[0]?.user_id ?? null;
      const benchSession = mintSessionForUser(ownerUserId);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': formatSessionCookie(benchSession.cookieValue),
      });
      res.end(JSON.stringify({ ok: true, cookieValue: benchSession.cookieValue }));
      return;
    }
  }

  // Public endpoints — no auth required.
  if (method === 'GET' && handleAuthExchange(url, res)) return;
  if (method === 'GET' && handleClassTokenRedemption(url, res)) return;
  if (method === 'GET' && handleOAuthStart(url, res)) return;
  if (method === 'GET' && url.pathname === '/oauth/google/callback') {
    void handleOAuthCallback(url, res).catch((err) => {
      log.error('OAuth callback error', { err });
      if (!res.headersSent) send(res, 500, { error: String(err) });
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/google-auth/start') {
    void handleGoogleAuthStart(req, res).catch((err) => {
      log.error('Google-auth start handler crashed', { err });
      if (!res.headersSent) send(res, 500, { error: 'Google auth start failed' });
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/google-auth/callback') {
    void handleGoogleAuthCallback(req, res).catch((err) => {
      log.error('Google-auth callback handler crashed', { err });
      if (!res.headersSent) send(res, 500, { error: 'Google auth callback failed' });
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/login') {
    return serveStatic(res, 'login.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/login.js') {
    return serveStatic(res, 'login.js', 'application/javascript; charset=utf-8');
  }
  // Seat picker — only active in bypass mode; accessible before auth.
  if (method === 'GET' && url.pathname === '/seat-picker') {
    return serveStatic(res, 'seat-picker.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/seat-picker.js') {
    return serveStatic(res, 'seat-picker.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/api/seats') {
    const sc = readSeatsConfig();
    send(res, 200, {
      seats: sc.seats.map((s) => ({ label: s.label, slug: s.slug ?? s.folder })),
      passwordRequired: !!sc.password,
    });
    return;
  }
  if (method === 'POST' && url.pathname === '/pick-seat') {
    void (async () => {
      try {
        const body = (await readJsonBody(req)) as { slug?: string; password?: string };
        const sc = readSeatsConfig();
        if (sc.password && body.password !== sc.password) {
          send(res, 401, { error: 'Wrong password' });
          return;
        }
        const seat = sc.seats.find((s) => (s.slug ?? s.folder) === body.slug);
        if (!seat) {
          send(res, 400, { error: 'Unknown seat' });
          return;
        }
        send(res, 200, { ok: true, redirectUrl: `/playground/?seat=${encodeURIComponent(seat.slug ?? seat.folder)}` });
      } catch (err) {
        if (!res.headersSent) send(res, 500, { error: String(err) });
      }
    })();
    return;
  }
  // Brand assets — served from the public dir, no auth required (they're
  // referenced by /login.html before the user has a session).
  if (method === 'GET' && url.pathname === '/favicon.png') {
    return serveStatic(res, 'favicon.png', 'image/png');
  }
  if (method === 'GET' && url.pathname === '/nanoclaw-icon.png') {
    return serveStatic(res, 'nanoclaw-icon.png', 'image/png');
  }
  if (method === 'GET' && url.pathname === '/agent-playground-icon.png') {
    return serveStatic(res, 'agent-playground-icon.png', 'image/png');
  }
  if (method === 'GET' && url.pathname === '/classroom-nano.png') {
    return serveStatic(res, 'classroom-nano.png', 'image/png');
  }
  if (method === 'POST' && url.pathname === '/login/recover') {
    void handleLostLinkRecover(req, res).catch((err) => {
      log.error('Lost-link recover error', { err });
      if (!res.headersSent) send(res, 500, { ok: false });
    });
    return;
  }
  // classroom-pin:routes START
  // Email-PIN dance for class-token URLs. Pre-auth (the whole point is the
  // user has no cookie yet). Three routes: GET the entry page, POST issue,
  // POST verify.
  if (method === 'GET' && url.pathname === '/login/pin') {
    return serveStatic(res, 'login-pin.html', 'text/html; charset=utf-8');
  }
  if (method === 'POST' && (url.pathname === '/login/pin/issue' || url.pathname === '/login/pin/verify')) {
    void (async () => {
      const { handleIssue, handleVerify } = await import('./api/login-pin.js');
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const result = url.pathname === '/login/pin/issue' ? await handleIssue(body) : handleVerify(body);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (result.setCookie) headers['set-cookie'] = result.setCookie;
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        log.error('login-pin handler error', { err });
        if (!res.headersSent) send(res, 500, { error: 'login-pin handler failed' });
      }
    })();
    return;
  }
  // classroom-pin:routes END

  // >>> classroom-pin:routes START — installed by /add-classroom-pin
  if (method === 'GET' && url.pathname === '/login/pin') {
    return serveStatic(res, 'login-pin.html', 'text/html; charset=utf-8');
  }
  if (method === 'POST' && url.pathname === '/login/pin/issue') {
    void (async () => {
      try {
        const body = (await readJsonBody(req)) as { token?: unknown };
        const result = await handleLoginPinIssue(body);
        send(res, result.status, result.body);
      } catch (err) {
        log.error('login-pin issue error', { err });
        if (!res.headersSent) send(res, 500, { ok: false });
      }
    })();
    return;
  }
  if (method === 'POST' && url.pathname === '/login/pin/verify') {
    void (async () => {
      try {
        const body = (await readJsonBody(req)) as { pendingId?: unknown; pin?: unknown };
        const result = handleLoginPinVerify(body);
        if (result.setCookie) res.setHeader('set-cookie', result.setCookie);
        send(res, result.status, result.body);
      } catch (err) {
        log.error('login-pin verify error', { err });
        if (!res.headersSent) send(res, 500, { ok: false });
      }
    })();
    return;
  }
  // <<< classroom-pin:routes END

  // ── class-enrollment-passcode:routes START ────────────────────────────────
  if (method === 'POST' && url.pathname === '/login/enroll') {
    void (async () => {
      try {
        const body = (await readJsonBody(req)) as { email?: unknown; passcode?: unknown };
        const result = handleEnroll(body);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (result.setCookie) headers['set-cookie'] = result.setCookie;
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        log.error('enrollment handler error', { err });
        if (!res.headersSent) send(res, 500, { error: 'enrollment failed' });
      }
    })();
    return;
  }
  // ── class-enrollment-passcode:routes END ──────────────────────────────────

  const session = PLAYGROUND_AUTH_BYPASS ? getBypassSession() : authenticate(req);
  if (!session) {
    if (method === 'GET' && isHtmlPagePath(url.pathname)) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Authorization required. Visit /login or send /playground on Telegram for a magic link.\n');
    return;
  }

  // `/` → playground. The pre-v3 landing page is retired; the Home tab inside
  // the playground is the new orientation surface.
  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { location: '/playground/' });
    res.end();
    return;
  }

  // Workbench static UI under /playground/. Serves index.html for the root path,
  // any file under PUBLIC_DIR otherwise.
  if (method === 'GET' && url.pathname === '/playground/') {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname.startsWith('/playground/')) {
    const rel = url.pathname.slice('/playground/'.length);
    // Path-traversal guard: reject .. or anything that resolves outside PUBLIC_DIR.
    if (rel.includes('..') || rel.startsWith('/')) {
      return send(res, 400, { error: 'invalid path' });
    }
    const ct = contentTypeFor(rel);
    if (!ct) return send(res, 404, { error: `Not served: ${rel}` });
    return serveStatic(res, rel, ct);
  }

  // ── class-enrollment-passcode:routes START ────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/admin/class-passcode') {
    const result = handleGetClassPasscode(session);
    send(res, result.status, result.body);
    return;
  }
  if (method === 'POST' && url.pathname === '/api/admin/class-passcode/rotate') {
    const result = handleRotateClassPasscode(session);
    send(res, result.status, result.body);
    return;
  }
  // ── class-enrollment-passcode:routes END ──────────────────────────────────

  // ── classroom-provider-auth:routes START ───────────────────────────────────
  if (url.pathname.startsWith('/provider-auth/')) {
    const m = url.pathname.match(/^\/provider-auth\/([^/]+)\/(start|exchange)$/);
    if (m) {
      const [, providerId, kind] = m;
      const userId = session.userId;
      if (!userId) {
        send(res, 401, { error: 'not signed in' });
        return;
      }
      if (kind === 'start' && method === 'GET') {
        const result = handleProviderAuthStart(providerId!, { userId });
        send(res, result.status, result.body);
        return;
      }
      if (kind === 'exchange' && method === 'POST') {
        void (async () => {
          try {
            const body = await readJsonBody(req);
            const result = await handleProviderAuthExchange(providerId!, body as { code?: string; state?: string }, {
              userId,
            });
            send(res, result.status, result.body);
          } catch (err) {
            log.error('provider-auth exchange error', { err });
            if (!res.headersSent) send(res, 500, { error: String(err) });
          }
        })();
        return;
      }
    }
  }
  if (url.pathname.startsWith('/api/me/providers/')) {
    const m = url.pathname.match(/^\/api\/me\/providers\/([^/]+)(?:\/(api-key|active))?$/);
    if (m) {
      const [, providerId, action] = m;
      const userId = session.userId;
      if (!userId) {
        send(res, 401, { error: 'not signed in' });
        return;
      }
      if (method === 'GET' && !action) {
        const result = handleGetProviderStatus(providerId!, { userId });
        send(res, result.status, result.body);
        return;
      }
      if (method === 'POST' && action === 'api-key') {
        void (async () => {
          try {
            const body = await readJsonBody(req);
            const result = handlePostApiKey(providerId!, body as { apiKey?: string }, { userId });
            send(res, result.status, result.body);
          } catch (err) {
            log.error('provider api-key post error', { err });
            if (!res.headersSent) send(res, 500, { error: String(err) });
          }
        })();
        return;
      }
      if (method === 'POST' && action === 'active') {
        void (async () => {
          try {
            const body = await readJsonBody(req);
            const result = handleSetActive(providerId!, body as { active?: 'apiKey' | 'oauth' }, { userId });
            send(res, result.status, result.body);
          } catch (err) {
            log.error('provider set-active post error', { err });
            if (!res.headersSent) send(res, 500, { error: String(err) });
          }
        })();
        return;
      }
      if (method === 'DELETE' && !action) {
        const which = url.searchParams.get('which') as 'apiKey' | 'oauth';
        const result = handleDisconnect(providerId!, { which }, { userId });
        send(res, result.status, result.body);
        return;
      }
    }
  }
  // ── classroom-provider-auth:routes END ─────────────────────────────────────

  // API
  void route(req, res, url, method, session).catch((err) => {
    log.error('Playground request error', { url: req.url, err });
    if (!res.headersSent) send(res, 500, { error: String(err) });
  });
}

function contentTypeFor(filename: string): string | null {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
  if (filename.endsWith('.svg')) return 'image/svg+xml';
  if (filename.endsWith('.ico')) return 'image/x-icon';
  return null; // unknown extension → not served (defense-in-depth)
}

function serveStatic(res: http.ServerResponse, filename: string, contentType: string): void {
  const file = path.join(PUBLIC_DIR, filename);
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, { error: `Not found: ${filename}` });
      return;
    }
    // No client cache for our HTML/JS/CSS so we don't get stuck behind
    // a broken cached copy after pushing a fix. Browsers were sticking
    // on a stale app.js that had a SyntaxError, defeating manual
    // hard-refreshes (the page reloaded but the cached JS came back).
    // Images get a short cache since they rarely change.
    const isImage = /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(filename);
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': isImage ? 'public, max-age=3600' : 'no-cache, must-revalidate',
    });
    res.end(data);
  });
}
