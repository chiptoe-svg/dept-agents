/**
 * GWS MCP relay — token-based authorization (closes C7).
 *
 * The pure `resolveRelayIdentity` tests below are necessary but not
 * sufficient: that helper never reads the group header by construction,
 * so a handler regression that re-introduced `headerGroup ?? tokenGroup`
 * would pass every pure test while still being exploitable. The
 * request-path suite drives the real HTTP handler (mocking only the tool
 * dispatch + DB lookup) so a handler-level regression is caught too.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTest, mintContainerToken } from './container-identity.js';

// listenLoopbackAndGateway (used by startGwsMcpRelay) resolves the gateway
// via CONTAINER_HOST_GATEWAY(), which memoizes on first call and otherwise
// tries to bind the real container bridge. Force it to resolve to
// 127.0.0.1 — equal to the loopback host — so the helper skips the second
// bind and this suite exercises a single 127.0.0.1 listener.
process.env.CONTAINER_HOST_GATEWAY = '127.0.0.1';

const { knownAgentGroups, dispatched } = vi.hoisted(() => ({
  knownAgentGroups: new Set<string>(),
  dispatched: [] as Array<{ ctx: { agentGroupId: string | null }; toolName: string; args: unknown }>,
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) =>
    knownAgentGroups.has(id) ? { id, name: id, folder: id, created_at: '' } : null,
  ),
}));

vi.mock('./gws-mcp-server.js', () => ({
  listToolNames: vi.fn(() => ['drive_doc_read_as_markdown']),
  dispatchTool: vi.fn(async (opts: { ctx: { agentGroupId: string | null }; toolName: string; args: unknown }) => {
    dispatched.push(opts);
    return { ok: true, fileId: 'stub', markdown: 'stub', bytes: 4 };
  }),
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// startGwsMcpRelay binds GWS_MCP_RELAY_PORT from config; override env
// before import so we get an ephemeral port. config.ts evaluates at
// import time, so use vi.hoisted to be early enough.
vi.hoisted(() => {
  process.env.GWS_MCP_RELAY_PORT = '0';
});

import { resolveRelayIdentity, startGwsMcpRelay, stopGwsMcpRelay } from './gws-mcp-relay.js';

describe('resolveRelayIdentity', () => {
  beforeEach(() => _resetForTest());

  it('resolves the group from the token', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': t })).toBe('ag_alice');
  });

  it('ignores a spoofed group header', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': t, 'x-nanoclaw-agent-group': 'ag_bob' })).toBe('ag_alice');
  });

  it('returns null with no token, even when a group header is present', () => {
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-group': 'ag_bob' })).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': 'deadbeef' })).toBeNull();
  });

  it('returns null for an array-valued token header, even when it contains a valid token', () => {
    // Direct coverage of the `typeof raw === 'string' ? raw : null` guard.
    // A comma-joined string (what Node actually delivers for repeated
    // headers) can never collide with a minted token, so that path can't
    // demonstrate the guard is doing anything. Passing a genuinely valid
    // token inside an array is the assertion that actually pins it: if the
    // guard were ever loosened to accept arrays (e.g. `raw[0]`), this would
    // start resolving to 'ag_alice' instead of null.
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveRelayIdentity({ 'x-nanoclaw-agent-token': [t, 'x'] })).toBeNull();
  });
});

describe('GWS relay request path — token authorization (C7)', () => {
  let port = 0;

  beforeEach(async () => {
    _resetForTest();
    knownAgentGroups.clear();
    dispatched.length = 0;
    const handle = await startGwsMcpRelay('127.0.0.1');
    const loopback = handle.servers.find((s) => (s.address() as AddressInfo).address === '127.0.0.1')!;
    port = (loopback.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await stopGwsMcpRelay();
  });

  interface RawResponse {
    status: number;
    body: string;
  }

  function request(opts: {
    method: string;
    path: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  }): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: opts.path, method: opts.method, headers: opts.headers || {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  // Pins the request path, not just the pure resolver. Alice's real token
  // rides alongside a spoofed group header naming Bob's group; if the
  // handler ever read the header instead of (or in addition to) the
  // token, dispatchTool would see ag_bob and this assertion fails.
  it('dispatches with the token-derived group, ignoring a spoofed agent-group header', async () => {
    // Register the spoofed target group too — otherwise a mutated resolver
    // that trusted the header would be caught by the group-existence check
    // (401, dispatchTool never called) before the identity assertion below
    // ever runs. Registering ag_bob makes that assertion the thing actually
    // pinning the behavior.
    knownAgentGroups.add('ag_alice');
    knownAgentGroups.add('ag_bob');
    const aliceToken = mintContainerToken('ag_alice', 'sess_alice');

    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: {
        'content-type': 'application/json',
        'x-nanoclaw-agent-token': aliceToken,
        'x-nanoclaw-agent-group': 'ag_bob',
      },
      body: JSON.stringify({ file_id: 'doc_abc' }),
    });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.ctx.agentGroupId).toBe('ag_alice');
  });

  // Pins the 401 gate itself: deleting it (or the resolveRelayIdentity
  // call feeding it) would let this request fall through to dispatchTool
  // even with a spoofed group header and no token.
  it('rejects a request with no token, even when a group header is present → 401', async () => {
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-group': 'ag_bob' },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('rejects an unknown token → 401', async () => {
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': 'deadbeef-not-a-real-token' },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('rejects an empty-string token → 401', async () => {
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': '' },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a comma-joined value from a repeated token header → 401', async () => {
    // node:http coalesces repeated ordinary headers into a single
    // comma-joined string on the way in (set-cookie is the documented
    // exception, not this header) — so http.request({headers: {..: [a,b]}})
    // is observed server-side as req.headers['x-nanoclaw-agent-token'] ===
    // 'tok1, tok2', a plain string. This test exercises that comma-joined
    // value as an unknown-token miss; it does NOT exercise the
    // `typeof raw === 'string' ? raw : null` array-branch of
    // resolveRelayIdentity — see the direct pure-function test below for
    // that.
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': ['tok1', 'tok2'] },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });
});
