/**
 * GWS MCP relay HTTP tests. Stubs the tool dispatch + DB lookup so the
 * suite verifies just the HTTP contract: header auth, agent-group
 * existence check, JSON body parsing, status-code propagation.
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
  listToolNames: vi.fn(() => ['drive_doc_read_as_markdown', 'drive_doc_write_from_markdown']),
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

import { startGwsMcpRelay, stopGwsMcpRelay } from './gws-mcp-relay.js';

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
  headers?: Record<string, string>;
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

describe('GWS MCP relay', () => {
  it('GET /tools returns the tool list (no auth required)', async () => {
    const res = await request({ method: 'GET', path: '/tools' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tools).toContain('drive_doc_read_as_markdown');
  });

  it('POST /tools/<name> without X-NanoClaw-Agent-Token → 401', async () => {
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain('X-NanoClaw-Agent-Token');
  });

  it('POST /tools/<name> with a token for an unknown agent_group_id → 401', async () => {
    const token = mintContainerToken('ag_unknown', 'sess_1');
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': token },
      body: JSON.stringify({ file_id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain('Unknown agent_group_id');
  });

  it('POST /tools/<name> with a valid token dispatches with the token-derived group', async () => {
    knownAgentGroups.add('ag_real');
    const token = mintContainerToken('ag_real', 'sess_1');
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': token },
      body: JSON.stringify({ file_id: 'doc_abc' }),
    });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.ctx.agentGroupId).toBe('ag_real');
    expect(dispatched[0]!.toolName).toBe('drive_doc_read_as_markdown');
    expect(dispatched[0]!.args).toEqual({ file_id: 'doc_abc' });
  });

  it('POST with malformed JSON → 400', async () => {
    knownAgentGroups.add('ag_real');
    const token = mintContainerToken('ag_real', 'sess_1');
    const res = await request({
      method: 'POST',
      path: '/tools/drive_doc_read_as_markdown',
      headers: { 'content-type': 'application/json', 'x-nanoclaw-agent-token': token },
      body: '{broken',
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('JSON');
  });

  it('Unknown route → 404', async () => {
    const res = await request({ method: 'GET', path: '/nope' });
    expect(res.status).toBe(404);
  });
});
