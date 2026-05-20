/**
 * Phase 1 smoke test for plans/classroom-web-multiuser.md.
 *
 * Spins up the playground HTTP server bound to 127.0.0.1 on an ephemeral
 * port, then walks through:
 *
 *   1. Mint magic token T1 for telegram:1, exchange at /auth → cookie C1
 *   2. Mint magic token T2 for telegram:2, exchange at /auth → cookie C2
 *   3. Both cookies should authorize requests independently
 *   4. revokeSessionsForUser('telegram:1') drops C1 only; C2 still works
 *   5. stopPlaygroundServer() drops everything
 *
 * Throws on any unexpected status, exit code 0 on success.
 *
 * Run from worktree root: `pnpm exec tsx scripts/smoke-playground-multiuser.ts`
 */

// Set required env BEFORE importing config-dependent modules — config.ts
// reads at import time. ESM hoists static imports above any code, so
// playground/config imports must be dynamic, after the env assignments.
process.env.PLAYGROUND_ENABLED = '1';
process.env.PLAYGROUND_PORT = process.env.PLAYGROUND_PORT || '4302';
process.env.PLAYGROUND_BIND_HOST = '127.0.0.1';

import http from 'http';

const { initChannelAdapters } = await import('../src/channels/channel-registry.js');
const {
  _resetSessionsForTest,
  _sessionCountForTest,
  createSessionFromMagicToken,
  mintMagicToken,
  revokeSessionsForUser,
  startPlaygroundServer,
  stopPlaygroundServer,
} = await import('../src/channels/playground.js');

const PORT = parseInt(process.env.PLAYGROUND_PORT!, 10);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(path: string, cookie?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'GET',
        headers: cookie ? { cookie } : {},
      },
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
  if (!setCookie) throw new Error('expected Set-Cookie header on /auth response');
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  // First segment up to ';' is the name=value pair we want to send back.
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
  // The router setupFn is a stub: smoke test never sends a chat message,
  // so onInbound/onInboundEvent are no-ops.
  const stubSetup = {
    onInbound: () => {},
    onInboundEvent: () => {},
  } as unknown as Parameters<Parameters<typeof initChannelAdapters>[0]>[0] extends infer A
    ? A extends { setup: (cfg: infer C) => unknown }
      ? C
      : never
    : never;

  await initChannelAdapters(() => stubSetup);

  // Clean slate (initChannelAdapters doesn't clear sessions; this is just
  // belt-and-suspenders for repeat runs).
  _resetSessionsForTest();

  const startResult = await startPlaygroundServer({ userId: 'telegram:1' });
  console.log(`server up: ${startResult.url}`);

  // -- Token T1 -- exchange at /auth, capture cookie C1.
  const t1 = new URL(startResult.url).searchParams.get('key')!;
  const auth1 = await get(`/auth?key=${encodeURIComponent(t1)}`);
  assert(auth1.status === 302, `T1 /auth → 302 (got ${auth1.status})`);
  const c1 = extractCookie(auth1.headers['set-cookie']);
  console.log(`C1: ${c1.slice(0, 30)}…`);

  // -- Token T2 -- mint a fresh one as if a second /playground was sent.
  const t2 = mintMagicToken('telegram:2');
  const auth2 = await get(`/auth?key=${encodeURIComponent(t2)}`);
  assert(auth2.status === 302, `T2 /auth → 302 (got ${auth2.status})`);
  const c2 = extractCookie(auth2.headers['set-cookie']);
  console.log(`C2: ${c2.slice(0, 30)}…`);
  assert(c1 !== c2, 'C1 and C2 are distinct cookies');

  // Use /api/home/me as a stable JSON endpoint: 401 unauth, 200 authed.
  // (Phase 2 changed `/` to redirect on miss + serve home.html on hit, so
  // the prior "401 vs 200 on /" check no longer holds.)
  const unauthed = await get('/api/home/me');
  assert(unauthed.status === 401, `no-cookie GET /api/home/me → 401 (got ${unauthed.status})`);

  const c1AuthedBefore = await get('/api/home/me', c1);
  assert(c1AuthedBefore.status === 200, `C1 GET /api/home/me passes auth (got ${c1AuthedBefore.status})`);

  const c2AuthedBefore = await get('/api/home/me', c2);
  assert(c2AuthedBefore.status === 200, `C2 GET /api/home/me passes auth (got ${c2AuthedBefore.status})`);

  assert(_sessionCountForTest() === 2, `session count = 2 after both /auth (got ${_sessionCountForTest()})`);

  // Revoke telegram:1 only. C1 should now 401, C2 should still pass.
  const removed = revokeSessionsForUser('telegram:1');
  assert(removed === 1, `revokeSessionsForUser(telegram:1) → 1 (got ${removed})`);

  const c1AfterRevoke = await get('/api/home/me', c1);
  assert(c1AfterRevoke.status === 401, `C1 GET /api/home/me → 401 after revoke (got ${c1AfterRevoke.status})`);

  const c2AfterRevoke = await get('/api/home/me', c2);
  assert(c2AfterRevoke.status === 200, `C2 GET /api/home/me still authed (got ${c2AfterRevoke.status})`);

  // Re-mint a session for telegram:1 and confirm /playground stop nukes everything.
  const t1b = mintMagicToken('telegram:1');
  const sessionForRetry = createSessionFromMagicToken(t1b)!;
  assert(_sessionCountForTest() === 2, `re-mint → session count back to 2 (got ${_sessionCountForTest()})`);

  await stopPlaygroundServer();
  assert(_sessionCountForTest() === 0, `stopPlaygroundServer → session count 0 (got ${_sessionCountForTest()})`);
  // sessionForRetry is dead now too, by construction — assert it's gone.
  void sessionForRetry; // referenced just to silence the unused-binding lint

  console.log('\n✅ Phase 1 smoke PASS');
}

main().catch((err) => {
  console.error('\n❌ Phase 1 smoke FAIL:', err);
  process.exitCode = 1;
  void stopPlaygroundServer().catch(() => {});
});
