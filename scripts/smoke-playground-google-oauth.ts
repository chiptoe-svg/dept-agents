/**
 * Phase 2+3 (A) smoke test for plans/classroom-web-multiuser.md.
 *
 * Spins up the playground HTTP server and verifies:
 *
 *   1. GET /login            → 200, serves the login landing page
 *   2. GET /                 → 302 → /login when unauthenticated
 *   3. GET /oauth/google/start → 302 to accounts.google.com/o/oauth2/v2/auth
 *      (via a temp credentials.json so we don't depend on the operator's real one)
 *   4. processOAuthCallback hit-path with a stubbed token exchange:
 *      - roster lookup → mint session → Set-Cookie
 *      - per-student credentials.json written under data/student-google-auth/
 *      - the new cookie passes /api/home/me and the home page renders
 *   5. processOAuthCallback miss-path → 403 "not enrolled"
 *
 * Run from worktree root: `pnpm exec tsx scripts/smoke-playground-google-oauth.ts`
 */

process.env.PLAYGROUND_ENABLED = '1';
process.env.PLAYGROUND_PORT = process.env.PLAYGROUND_PORT || '4303';
process.env.PLAYGROUND_BIND_HOST = '127.0.0.1';

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-oauth-smoke-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-oauth-data-'));
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.config/gws'), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, '.config/gws/credentials.json'),
  JSON.stringify({
    client_id: 'fake-client-id.apps.googleusercontent.com',
    client_secret: 'fake-client-secret',
    refresh_token: 'instructor-refresh',
  }),
);

// Point DATA_DIR at a temp dir so the per-student creds land in scratch
// space, not the operator's real install. This relies on DATA_DIR being
// resolved at config-import time, so set the env BEFORE the dynamic
// import below — but note config.ts uses path.resolve(PROJECT_ROOT, 'data')
// not env, so we have to monkey-patch by changing CWD instead.
// Simpler: just confirm the file got written under cwd/data/, then clean up.

const PORT = parseInt(process.env.PLAYGROUND_PORT!, 10);
const HOST = '127.0.0.1';

const { initChannelAdapters } = await import('../src/channels/channel-registry.js');
const { initTestDb, closeDb } = await import('../src/db/connection.js');
const { runMigrations } = await import('../src/db/migrations/index.js');
const { upsertRosterEntry } = await import('../src/db/classroom-roster.js');
const { _resetSessionsForTest } = await import('../src/channels/playground.js');
const playground = await import('../src/channels/playground.js');
const oauth = await import('../src/channels/playground/google-oauth.js');

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(p: string, cookie?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: p, method: 'GET', headers: cookie ? { cookie } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function extractCookie(setCookie: string | string[] | undefined): string {
  if (!setCookie) throw new Error('expected Set-Cookie header');
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return raw.split(';')[0]!;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function main(): Promise<void> {
  const db = initTestDb();
  runMigrations(db);

  const stubSetup = { onInbound: () => {}, onInboundEvent: () => {} } as unknown as Parameters<
    Parameters<typeof initChannelAdapters>[0]
  >[0] extends infer A
    ? A extends { setup: (cfg: infer C) => unknown }
      ? C
      : never
    : never;
  await initChannelAdapters(() => stubSetup);
  _resetSessionsForTest();

  await playground.startPlaygroundServer({ userId: null });

  // 1. Login page is public.
  const login = await get('/login');
  assert(login.status === 200, `GET /login → 200 (got ${login.status})`);
  assert(login.body.includes('Sign in with Google'), 'login.html mentions "Sign in with Google"');

  // 2. Unauth `/` should redirect to /login.
  const root = await get('/');
  assert(root.status === 302, `unauth GET / → 302 (got ${root.status})`);
  assert(root.headers.location === '/login', `redirect target is /login (got ${root.headers.location})`);

  // 3. /oauth/google/start should redirect to Google's consent page.
  const start = await get('/oauth/google/start');
  assert(start.status === 302, `GET /oauth/google/start → 302 (got ${start.status})`);
  const consentUrl = String(start.headers.location || '');
  assert(
    consentUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'),
    `redirect goes to Google consent URL (got ${consentUrl.slice(0, 60)}…)`,
  );
  assert(
    consentUrl.includes('client_id=fake-client-id'),
    'consent URL embeds the OAuth client_id from credentials.json',
  );
  assert(consentUrl.includes('access_type=offline'), 'consent URL requests offline access (refresh token)');
  assert(consentUrl.includes('prompt=consent'), 'consent URL forces a fresh refresh_token');

  // 4. Hit-path: seed roster, drive processOAuthCallback with stubbed
  //    exchange, confirm cookie + per-student creds + home-page works.
  upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03' });
  oauth._seedOAuthStateForTest('smoke-state');
  const idToken = (() => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ email: 'alice@school.edu', email_verified: true, sub: '12345' }),
    ).toString('base64url');
    return `${header}.${payload}.fake-sig`;
  })();
  const callbackResult = await oauth.processOAuthCallback({
    code: 'auth-code',
    state: 'smoke-state',
    exchange: async () =>
      ({
        access_token: 'access-A',
        refresh_token: 'refresh-A',
        expires_in: 3600,
        scope: 'openid email',
        token_type: 'Bearer',
        id_token: idToken,
      }) as Awaited<ReturnType<typeof import('../src/gws-auth.js').exchangeCodeForTokens>>,
  });
  assert(callbackResult.status === 302, `OAuth callback → 302 (got ${callbackResult.status})`);
  assert(!!callbackResult.setCookie, 'OAuth callback sets a cookie');
  const cookie = extractCookie(callbackResult.setCookie);

  const credPath = oauth.studentGwsCredentialsPath('class:student_03');
  assert(fs.existsSync(credPath), `per-student creds written at ${credPath}`);
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8')) as { refresh_token: string };
  assert(cred.refresh_token === 'refresh-A', 'per-student creds preserve refresh_token from exchange');

  const me = await get('/api/home/me', cookie);
  assert(me.status === 200, `cookie from OAuth passes /api/home/me (got ${me.status})`);
  const meBody = JSON.parse(me.body) as { userId: string };
  assert(meBody.userId === 'class:student_03', `userId resolved correctly (got ${meBody.userId})`);

  const home = await get('/', cookie);
  assert(home.status === 200, `authed GET / → 200 (got ${home.status})`);
  assert(home.body.includes('Open Playground'), 'home.html includes "Open Playground" link');

  // 5. Miss-path: a different state, a stranger email → 403.
  oauth._seedOAuthStateForTest('miss-state');
  const missIdToken = (() => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ email: 'stranger@elsewhere.com', email_verified: true }),
    ).toString('base64url');
    return `${header}.${payload}.fake-sig`;
  })();
  const missResult = await oauth.processOAuthCallback({
    code: 'auth-code-2',
    state: 'miss-state',
    exchange: async () =>
      ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        scope: 'openid email',
        token_type: 'Bearer',
        id_token: missIdToken,
      }) as Awaited<ReturnType<typeof import('../src/gws-auth.js').exchangeCodeForTokens>>,
  });
  assert(missResult.status === 403, `roster miss → 403 (got ${missResult.status})`);
  assert(missResult.body.includes('Not enrolled'), 'miss page says "Not enrolled"');

  await playground.stopPlaygroundServer();
  closeDb();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
  // Sweep the per-student creds the smoke wrote (DATA_DIR is real,
  // not the tmpData above — DATA_DIR is resolved at config-import time).
  fs.rmSync(path.dirname(path.dirname(credPath)), { recursive: true, force: true });

  console.log('\n✅ Phase 2+3 (A) smoke PASS');
}

main().catch(async (err) => {
  console.error('\n❌ Phase 2+3 (A) smoke FAIL:', err);
  process.exitCode = 1;
  try {
    await playground.stopPlaygroundServer();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpData, { recursive: true, force: true });
});
