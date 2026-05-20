/**
 * Integration tests for the install handoff HTTP server.
 *
 * Uses real bundle dirs in tmpdir and real store operations (in-memory SQLite).
 * No mocks for the route logic — these are integration-quality tests in vitest
 * clothing, exercising the full request path.
 *
 * Each describe block gets its own server instance on a random OS-assigned port
 * (:0). Servers are started before and stopped after each test block, so there
 * are no port leaks across tests.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { moduleInstallHandoffs } from '../db/migrations/module-install-handoffs.js';

// ---------------------------------------------------------------------------
// Per-suite setup: tmpdir, in-memory DB, mocks
// ---------------------------------------------------------------------------

let tmpRoot: string;
let fakeDataDir: string;
let db: Database.Database;

// These are set by beforeAll/beforeEach and captured for test cleanup.
let currentServer: http.Server | null = null;

/**
 * Make an HTTP GET request to the given path on the test server.
 * Returns { status, headers, body } for assertions.
 */
function get(server: http.Server, urlPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import('net').AddressInfo;
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method: 'GET',
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Start a fresh server on a random port for this test run.
 * Returns the server + the store/bundler modules (re-imported after mock setup).
 */
async function startTestServer(): Promise<{
  server: http.Server;
  store: typeof import('./store.js');
}> {
  // Re-import server module (fresh module after vi.resetModules in afterEach).
  const serverMod = await import('./server.js');
  const store = await import('./store.js');

  // Start on port 0 (OS picks a free port).
  const server = await serverMod.startHandoffServer('127.0.0.1');
  currentServer = server;
  return { server, store };
}

// ---------------------------------------------------------------------------
// Global beforeAll/afterAll: tmpdir + DB + mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-srv-test-'));
  fakeDataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(fakeDataDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Per-test setup: fresh in-memory DB + mocks.
beforeEach(() => {
  db = new Database(':memory:');
  moduleInstallHandoffs.up(db);

  vi.doMock('../db/connection.js', () => ({ getDb: () => db }));
  vi.doMock('../config.js', () => ({
    DATA_DIR: fakeDataDir,
    INSTALL_HANDOFF_PORT: 0, // port 0 → OS assigns a free port
  }));
  vi.doMock('../log.js', () => ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  }));
});

afterEach(async () => {
  // Stop the server if one was started.
  if (currentServer) {
    const serverMod = await import('./server.js');
    await serverMod.stopHandoffServer();
    currentServer = null;
  }
  db.close();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helper: write a real bundle dir under tmpdir
// ---------------------------------------------------------------------------

function writeBundleFile(token: string, filename: string, content = 'fake-content'): void {
  const dir = path.join(fakeDataDir, 'handoffs', token);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

// ---------------------------------------------------------------------------
// Tests: install.html route (not counted)
// ---------------------------------------------------------------------------

describe('GET /handoff/:token/install.html', () => {
  it('returns 200 with rendered install template for a valid token', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 3,
      files: [{ name: 'env', size: 10 }],
    });

    const res = await get(server, `/handoff/${issued.token}/install.html`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Template substitution happened: token fingerprint, max-uses, file count, curl block.
    expect(res.body).toContain(`${issued.token.slice(0, 8)}`);
    expect(res.body).toContain('Uses left:');
    // Curl block: URL= line carries the full token; downloads use $URL/<file>
    expect(res.body).toContain(`/handoff/${issued.token}`);
    expect(res.body).toContain('$URL/env');
    expect(res.body).toContain('git clone');
    expect(res.body).toContain('bash nanoclaw.sh');
    expect(res.body).toContain('data-platform="mac"');
    expect(res.body).toContain('data-platform="linux"');
  });

  it('does NOT decrement uses when install.html is fetched (second fetch still 200)', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });

    const r1 = await get(server, `/handoff/${issued.token}/install.html`);
    expect(r1.status).toBe(200);

    const r2 = await get(server, `/handoff/${issued.token}/install.html`);
    expect(r2.status).toBe(200);

    // current_uses should still be 0.
    const handoff = store.getHandoff(issued.token);
    expect(handoff.ok).toBe(true);
    if (handoff.ok) expect(handoff.current_uses).toBe(0);
  });

  it('returns 404 for an unknown token', async () => {
    const { server } = await startTestServer();
    const res = await get(server, '/handoff/deadbeefdeadbeefdeadbeefdeadbeef/install.html');
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/unknown-token/);
  });

  it('returns 404 for an expired token', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    // Force expiry.
    db.prepare('UPDATE install_handoffs SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      issued.id,
    );

    const res = await get(server, `/handoff/${issued.token}/install.html`);
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/expired/);
  });

  it('returns 404 for a revoked token', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    store.revokeHandoff(issued.id);

    const res = await get(server, `/handoff/${issued.token}/install.html`);
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/revoked/);
  });

  it('returns 404 for an exhausted token', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    // Force exhaustion via DB (simulates a prior download having consumed it).
    db.prepare('UPDATE install_handoffs SET current_uses = 1, revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      issued.id,
    );

    const res = await get(server, `/handoff/${issued.token}/install.html`);
    expect(res.status).toBe(404);
    // exhausted shows as revoked (revoked_at is set) — accept either reason
    expect(res.body).toMatch(/revoked|exhausted/);
  });
});

// ---------------------------------------------------------------------------
// Tests: file download route (counted)
// ---------------------------------------------------------------------------

describe('GET /handoff/:token/:file (download)', () => {
  it('serves a bundled file with correct headers and decrements counter', async () => {
    const { server, store } = await startTestServer();
    const content = 'ANTHROPIC_API_KEY=sk-test-12345\n';
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 3,
      files: [{ name: 'env', size: Buffer.byteLength(content) }],
    });
    writeBundleFile(issued.token, 'env', content);

    const before = store.getHandoff(issued.token);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.current_uses).toBe(0);

    const res = await get(server, `/handoff/${issued.token}/env`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="env"');
    expect(res.body).toBe(content);

    const after = store.getHandoff(issued.token);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.current_uses).toBe(1);
  });

  it('returns 404 for a file not in the manifest', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    writeBundleFile(issued.token, 'env', 'data');
    // Request a file that IS on disk but NOT in the manifest.
    writeBundleFile(issued.token, 'secret.txt', 'should not be served');

    const res = await get(server, `/handoff/${issued.token}/secret.txt`);
    expect(res.status).toBe(404);
    expect(res.body).toMatch(/not in bundle/);
  });

  it('exhausts counter and revokes token after max_uses downloads', async () => {
    const { server, store } = await startTestServer();
    const content = 'KEY=value';
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 2,
      files: [{ name: 'env', size: Buffer.byteLength(content) }],
    });
    writeBundleFile(issued.token, 'env', content);

    const r1 = await get(server, `/handoff/${issued.token}/env`);
    expect(r1.status).toBe(200);

    const r2 = await get(server, `/handoff/${issued.token}/env`);
    expect(r2.status).toBe(200);

    // Third attempt — token is now exhausted / revoked.
    const r3 = await get(server, `/handoff/${issued.token}/env`);
    expect(r3.status).toBe(404);

    // The handoff should be gone (revoked_at set).
    const handoff = store.getHandoff(issued.token);
    expect(handoff.ok).toBe(false);
  });

  it('returns 404 on download for an unknown token', async () => {
    const { server } = await startTestServer();
    const res = await get(server, '/handoff/deadbeefdeadbeefdeadbeefdeadbeef/env');
    expect(res.status).toBe(404);
  });

  it('returns 404 on download for a revoked token', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    writeBundleFile(issued.token, 'env', 'data');
    store.revokeHandoff(issued.id);

    const res = await get(server, `/handoff/${issued.token}/env`);
    expect(res.status).toBe(404);
  });

  it('path-traversal attempt returns 404 (not in manifest)', async () => {
    const { server, store } = await startTestServer();
    const issued = store.issueHandoff({
      ttlMs: 60_000,
      maxUses: 1,
      files: [{ name: 'env', size: 10 }],
    });
    writeBundleFile(issued.token, 'env', 'data');

    // The URL cannot contain a slash in the :file segment due to the regex,
    // so path traversal via /handoff/token/../../../etc/passwd won't even
    // parse as { token, file }. Verify the route itself returns 404.
    const res = await get(server, `/handoff/${issued.token}/../../../../etc/passwd`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: unrelated paths
// ---------------------------------------------------------------------------

describe('unrelated paths', () => {
  it('returns 404 for paths that do not match the handoff route', async () => {
    const { server } = await startTestServer();

    const paths = ['/', '/health', '/handoff', `/handoff/token-only`];
    for (const p of paths) {
      const res = await get(server, p);
      expect(res.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: server lifecycle
// ---------------------------------------------------------------------------

describe('server lifecycle', () => {
  it('starts cleanly and stops without leaking the port', async () => {
    const { server } = await startTestServer();
    const addr = server.address() as import('net').AddressInfo;
    expect(addr.port).toBeGreaterThan(0);

    // Stop explicitly (afterEach will also call stopHandoffServer, which
    // is idempotent so double-stop is fine).
    const serverMod = await import('./server.js');
    await serverMod.stopHandoffServer();
    currentServer = null;

    // After stop, the server is closed — no port in use.
    expect(server.listening).toBe(false);
  });

  it('startHandoffServer is idempotent — second call returns same server', async () => {
    const { server } = await startTestServer();
    const serverMod = await import('./server.js');
    const server2 = await serverMod.startHandoffServer('127.0.0.1');
    expect(server2).toBe(server);
  });

  it('stopHandoffServer is idempotent — safe to call when not started', async () => {
    // Don't start anything — just stop.
    const serverMod = await import('./server.js');
    await expect(serverMod.stopHandoffServer()).resolves.toBeUndefined();
  });
});
