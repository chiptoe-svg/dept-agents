import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
// `vi.hoisted` ensures mockEnv exists when the vi.mock factory below
// runs — important now that credential-proxy.ts pulls in
// student-creds-paths → config → env at import time, which fires the
// readEnvFile mock factory before any non-hoisted file-scope const is
// initialized.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as Record<string, string> }));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Budget-enforcement mocks (Task p2-1). getAgentGroup resolves every id used
// anywhere in this file to a group whose folder equals its id, so every
// pre-existing test in this file (ag_alice, ag1, ag_carol, ag_bob, ...) gets
// a folder with no perAgent entry and a null default → assertGroupWithinBudget
// short-circuits to {ok:true} without even calling aggregateAgentUsage. Only
// 'ag_broke' (used by the dedicated budget-enforcement tests below) has a
// configured budget it exceeds.
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, folder: id }),
}));
vi.mock('./channels/playground/api/cost-budgets.js', () => ({
  readCostBudgets: () => ({ defaultMonthlyUsd: null, perAgent: { ag_broke: 1 }, warnFraction: 0.8 }),
  budgetForAgent: (
    folder: string,
    cfg: { perAgent: Record<string, number | null>; defaultMonthlyUsd: number | null },
  ) => (folder in cfg.perAgent ? cfg.perAgent[folder] : cfg.defaultMonthlyUsd),
  evaluateBudget: (costUsd: number, budgetUsd: number | null) =>
    budgetUsd == null
      ? { status: 'none' as const, costUsd, budgetUsd, fraction: null }
      : { status: (costUsd >= budgetUsd ? 'over' : 'ok') as 'over' | 'ok', costUsd, budgetUsd, fraction: 0 },
}));
vi.mock('./channels/playground/api/usage.js', () => ({
  aggregateAgentUsage: (id: string) => ({ thisMonth: { costUsd: id === 'ag_broke' ? 99 : 0 }, total: { costUsd: 0 } }),
}));

import {
  startCredentialProxy,
  setUserCredsHook,
  userCredsHook,
  serializeResolvedCredsError,
  resolveOmlxKey,
  resolveProxyRoute,
  isEgressAllowed,
  isLoopbackSource,
  resolveProxyIdentity,
} from './credential-proxy.js';
import { mintContainerToken, _resetForTest } from './container-identity.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Invoke a live http.Server's registered 'request' listener directly with a
 * fake req/res pair, so we can control `req.socket.remoteAddress` — a real
 * TCP connection made from this test process always looks like loopback to
 * the server, so there is no way to exercise the non-loopback path over the
 * network. This drives the exact same handler code (`createServer((req,
 * res) => {...})` inside startCredentialProxy) that a real socket would.
 */
function invokeRequestHandler(
  server: http.Server,
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
    body?: string;
  },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const listener = server.listeners('request')[0] as (req: unknown, res: unknown) => void;

    const req = new EventEmitter() as EventEmitter & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      socket?: { remoteAddress?: string };
    };
    req.method = opts.method ?? 'POST';
    req.url = opts.url ?? '/anthropic/v1/messages';
    req.headers = opts.headers ?? {};
    req.socket = { remoteAddress: opts.remoteAddress };

    let statusCode = 0;
    const bodyChunks: Buffer[] = [];
    let resolved = false;
    const res = new EventEmitter() as EventEmitter & {
      headersSent: boolean;
      writeHead: (status: number, headers?: unknown) => void;
      write: (chunk: unknown) => boolean;
      end: (data?: unknown) => void;
    };
    res.headersSent = false;
    res.writeHead = (status: number) => {
      statusCode = status;
      res.headersSent = true;
    };
    res.write = (chunk: unknown) => {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = (data?: unknown) => {
      if (data) bodyChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      if (!resolved) {
        resolved = true;
        resolve({ statusCode, body: Buffer.concat(bodyChunks).toString() });
      }
    };

    listener(req, res);
    process.nextTick(() => {
      req.emit('data', Buffer.from(opts.body ?? '{}'));
      req.emit('end');
    });
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer real-oauth-token');
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('strips the X-NanoClaw-Agent-Group attribution header before forwarding upstream', async () => {
    // Per-call attribution: the container-side proxy-fetch wrapper adds
    // this header so the proxy's per-student resolvers can route. It is
    // a NanoClaw-internal hint and must not leak to api.anthropic.com /
    // api.openai.com / www.googleapis.com.
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          'x-nanoclaw-agent-group': 'ag_some_group_id',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-nanoclaw-agent-group']).toBeUndefined();
    // The real-key substitution path still works alongside the strip.
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode + attribution header: real token still injected, header stripped', async () => {
    // X.4 regression check (master-plan Phase 1 #5). X.1–X.3 added the
    // x-nanoclaw-agent-group header to enable per-student resolvers; this
    // test pins that the Anthropic OAuth substitution path (the existing
    // getOAuthToken / envToken flow) still fires when the header is
    // present. A buggy implementation that gated token injection on the
    // header being absent (or vice versa) would silently break the
    // instructor OAuth fallback documented in master-plan Phase 1
    // success criterion #2.
    proxyPort = await startProxy({ CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
          'x-nanoclaw-agent-group': 'ag_class_student_test',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer real-oauth-token');
    expect(lastUpstreamHeaders['x-nanoclaw-agent-group']).toBeUndefined();
  });

  it('a request without the attribution header still works (graceful fallback)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      '{}',
    );

    // No header → no per-student lookup → instructor / class-default
    // credential. Same behavior as pre-attribution era.
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('returns 403 for a bare /v1/messages path (old catch-all path — no prefix)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'endpoint not allowed by nanoclaw egress policy' });
    // No upstream request was made — the upstream mock server was never hit
    expect(lastUpstreamHeaders).toEqual({});
  });

  it('returns 403 for an unrecognized prefix like /foo/bar', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/foo/bar',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'endpoint not allowed by nanoclaw egress policy' });
    // No upstream request was made — the upstream mock server was never hit
    expect(lastUpstreamHeaders).toEqual({});
  });

  it('returns 403 for a disallowed path within a valid route (egress allowlist gate)', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-test-openai' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/openai/v1/models',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'endpoint not allowed by nanoclaw egress policy' });
    // Mock upstream must NOT have been hit — no credentials forwarded
    expect(lastUpstreamHeaders).toEqual({});
  });

  it('allows a loopback request with no token (host-internal caller, e.g. direct-chat)', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    // makeRequest always connects via 127.0.0.1, so this exercises the
    // loopback path with no x-nanoclaw-agent-token header at all.
    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).not.toBe(401);
  });

  // Fix B: pin the `!identity && !loopback → 401` gate (credential-proxy.ts
  // ~562-570). Previously only the loopback-allowed case was covered, which
  // stays green even if the 401 branch is deleted entirely. These drive a
  // simulated non-loopback source (real test-process sockets always look
  // like loopback, so we invoke the request listener directly — see
  // invokeRequestHandler) through every identity outcome.
  describe('non-loopback caller — 401 gate', () => {
    beforeEach(() => _resetForTest());

    it('no token → 401', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: { 'content-type': 'application/json' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('unknown token → 401', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-agent-token': 'deadbeef-not-a-real-token',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('empty-string token → 401', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: {
          'content-type': 'application/json',
          'x-nanoclaw-agent-token': '',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('valid token → not 401', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
      const token = mintContainerToken('ag_carol', 'sess_carol');

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          'x-nanoclaw-agent-token': token,
        },
      });

      expect(res.statusCode).not.toBe(401);
    });
  });

  // Task p2-1: budgets previously enforced only on /api/direct-chat — a
  // normal agent turn through the proxy had no cap. These pin the 429 gate
  // added at the one chokepoint every LLM call crosses (see mutation proof
  // in the task report: deleting the 429 block makes the first test fail).
  describe('budget enforcement', () => {
    beforeEach(() => _resetForTest());

    it('over-budget group gets 429 before any credential is attached', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
      const hook = vi.fn(async () => null);
      setUserCredsHook(hook);
      const token = mintContainerToken('ag_broke', 'sess_broke');

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          'x-nanoclaw-agent-token': token,
        },
      });

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body)).toEqual({ error: expect.stringMatching(/budget/i) });
      // No credential was even attached — the budget gate ran before userCredsHook.
      expect(hook).not.toHaveBeenCalled();

      setUserCredsHook(async () => null);
    });

    it('under-budget group is not blocked', async () => {
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
      const token = mintContainerToken('ag_solvent', 'sess_solvent');

      const res = await invokeRequestHandler(proxyServer, {
        remoteAddress: '192.168.64.7',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          'x-nanoclaw-agent-token': token,
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});

describe('isLoopbackSource', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.64.7', false],
    ['130.127.162.99', false],
    [undefined, false],
  ])('isLoopbackSource(%s) === %s', (addr, expected) => {
    expect(isLoopbackSource(addr as string | undefined)).toBe(expected);
  });
});

describe('resolveProxyIdentity', () => {
  beforeEach(() => _resetForTest());

  it('resolves the group from the token', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-token': t })).toEqual({
      agentGroupId: 'ag_alice',
      sessionId: 'sess_1',
    });
  });

  it('ignores a spoofed agent-group header — the token wins', () => {
    const t = mintContainerToken('ag_alice', 'sess_1');
    const id = resolveProxyIdentity({ 'x-nanoclaw-agent-token': t, 'x-nanoclaw-agent-group': 'ag_bob' });
    expect(id!.agentGroupId).toBe('ag_alice'); // NOT ag_bob
  });

  it('returns null with no token, even when a group header is present', () => {
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-group': 'ag_bob' })).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(resolveProxyIdentity({ 'x-nanoclaw-agent-token': 'deadbeef' })).toBeNull();
  });
});

describe('userCredsHook', () => {
  afterEach(() => {
    setUserCredsHook(async () => null);
  });

  it('default hook returns null (no-op for solo installs)', async () => {
    const result = await userCredsHook('any-gid', 'claude');
    expect(result).toBeNull();
  });

  it('setUserCredsHook installs a new hook globally', async () => {
    setUserCredsHook(async (gid, provider) => ({
      kind: 'apiKey',
      value: `key-for-${gid}-${provider}`,
    }));
    const result = await userCredsHook('g1', 'claude');
    expect(result).toEqual({ kind: 'apiKey', value: 'key-for-g1-claude' });
  });

  it('serializes connect_required sentinel to HTTP 402', () => {
    const { status, body } = serializeResolvedCredsError({
      kind: 'connect_required',
      provider: 'claude',
      message: 'Connect your Anthropic account to use this model.',
      connect_url: '/provider-auth/claude/start',
    });
    expect(status).toBe(402);
    expect(body).toEqual({
      type: 'connect_required',
      provider: 'claude',
      message: 'Connect your Anthropic account to use this model.',
      connect_url: '/provider-auth/claude/start',
    });
  });

  it('serializes forbidden sentinel to HTTP 403', () => {
    const { status, body } = serializeResolvedCredsError({
      kind: 'forbidden',
      provider: 'claude',
    });
    expect(status).toBe(403);
    expect(body).toEqual({ type: 'forbidden', provider: 'claude' });
  });
});

describe('credential-proxy OMLX_API_KEY default', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.OMLX_API_KEY;
    delete process.env.OMLX_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OMLX_API_KEY;
    else process.env.OMLX_API_KEY = originalKey;
  });

  it('defaults to "godfrey" when OMLX_API_KEY is unset', () => {
    expect(resolveOmlxKey()).toBe('godfrey');
  });

  it('uses OMLX_API_KEY env when set', () => {
    process.env.OMLX_API_KEY = 'classroom-shared-key';
    expect(resolveOmlxKey()).toBe('classroom-shared-key');
  });
});

describe('isEgressAllowed', () => {
  it('allows the chat/messages/responses endpoints + the anthropic OAuth exchange', () => {
    expect(isEgressAllowed('anthropic', 'POST', '/v1/messages')).toBe(true);
    expect(isEgressAllowed('anthropic', 'POST', '/api/oauth/claude_cli/create_api_key')).toBe(true);
    expect(isEgressAllowed('openai', 'POST', '/v1/responses')).toBe(true);
    expect(isEgressAllowed('openai', 'POST', '/v1/chat/completions')).toBe(true);
    expect(isEgressAllowed('openai-platform', 'POST', '/v1/chat/completions')).toBe(true);
    expect(isEgressAllowed('omlx', 'POST', '/v1/responses')).toBe(true);
    expect(isEgressAllowed('clemson', 'POST', '/v1/chat/completions')).toBe(true);
  });
  it('blocks the proven exploit and other non-chat endpoints', () => {
    expect(isEgressAllowed('openai', 'POST', '/v1/models')).toBe(false);
    expect(isEgressAllowed('openai', 'GET', '/v1/responses')).toBe(false);
    expect(isEgressAllowed('anthropic', 'POST', '/v1/models')).toBe(false);
    expect(isEgressAllowed('anthropic', 'GET', '/v1/messages')).toBe(false);
  });
  it('blocks the entire googleapis route (empty allowlist, dead route)', () => {
    expect(isEgressAllowed('googleapis', 'GET', '/drive/v3/files')).toBe(false);
    expect(isEgressAllowed('googleapis', 'POST', '/gmail/v1/users/me/messages/send')).toBe(false);
  });
  it('ignores query strings when matching', () => {
    expect(isEgressAllowed('anthropic', 'POST', '/v1/messages?beta=true')).toBe(true);
  });
  it('fails closed on case variants and bare-prefix paths (exact match, intentional)', () => {
    expect(isEgressAllowed('anthropic', 'POST', '/v1/Messages')).toBe(false); // path case-sensitive
    expect(isEgressAllowed('openai', 'POST', '/V1/responses')).toBe(false);
    expect(isEgressAllowed('anthropic', 'POST', '/')).toBe(false); // bare prefix → '/'
    expect(isEgressAllowed('anthropic', 'POST', '/v1/messages/')).toBe(false); // trailing slash
  });
  it('normalizes the HTTP method case', () => {
    expect(isEgressAllowed('openai', 'post', '/v1/chat/completions')).toBe(true);
  });
});

describe('resolveProxyRoute', () => {
  it('routes the new /anthropic prefix and strips it', () => {
    expect(resolveProxyRoute('/anthropic/v1/messages')).toEqual({ route: 'anthropic', upstreamPath: '/v1/messages' });
  });
  it('routes openai / openai-platform / omlx / clemson with prefix stripped', () => {
    expect(resolveProxyRoute('/openai/v1/responses')).toEqual({ route: 'openai', upstreamPath: '/v1/responses' });
    expect(resolveProxyRoute('/openai-platform/v1/chat/completions')).toEqual({
      route: 'openai-platform',
      upstreamPath: '/v1/chat/completions',
    });
    expect(resolveProxyRoute('/omlx/v1/chat/completions')).toEqual({
      route: 'omlx',
      upstreamPath: '/v1/chat/completions',
    });
    expect(resolveProxyRoute('/clemson/v1/responses')).toEqual({ route: 'clemson', upstreamPath: '/v1/responses' });
  });
  it('routes googleapis (kept for the allowlist gate to reject)', () => {
    expect(resolveProxyRoute('/googleapis/drive/v3/files')).toEqual({
      route: 'googleapis',
      upstreamPath: '/drive/v3/files',
    });
  });
  it('returns null for the bare path and unrecognized prefixes (no catch-all)', () => {
    expect(resolveProxyRoute('/v1/messages')).toBeNull();
    expect(resolveProxyRoute('/')).toBeNull();
    expect(resolveProxyRoute('/foo/bar')).toBeNull();
  });
  it('preserves query strings on the upstream path', () => {
    expect(resolveProxyRoute('/anthropic/v1/messages?beta=true')).toEqual({
      route: 'anthropic',
      upstreamPath: '/v1/messages?beta=true',
    });
  });
});

describe('credential-proxy payload log', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let payloadDir: string;

  beforeEach(async () => {
    payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-payloads-'));
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(payloadDir, { recursive: true, force: true });
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    setUserCredsHook(async () => null);
  });

  // Fix A: pin credential selection to the token, not the spoofable group
  // header. The C5 exploit shape: a container presents its own valid token
  // (ag_alice) plus a victim's group header (ag_bob). If credential-proxy.ts
  // ever computed `agentGroupId` from `headerGroup ?? identity?.agentGroupId`
  // instead of the token alone, this test must fail — the pure-helper test
  // for resolveProxyIdentity alone can't catch this because that helper
  // never reads the header by construction.
  it('derives agentGroupId from the token, never a spoofed group header (C5 exploit shape)', async () => {
    _resetForTest();
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', payloadDir);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const seenGroupIds: string[] = [];
    setUserCredsHook(async (agentGroupId) => {
      seenGroupIds.push(agentGroupId);
      return null;
    });

    // Alice's real token, but Bob's group header riding along.
    const aliceToken = mintContainerToken('ag_alice', 'sess_alice');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
          'x-nanoclaw-agent-token': aliceToken,
          'x-nanoclaw-agent-group': 'ag_bob',
        },
      },
      '{}',
    );

    // The credential hook must only ever see the token's group.
    expect(seenGroupIds).toEqual(['ag_alice']);

    // The payload row lands under the token's group, never the spoofed one.
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(payloadDir, 'ag_alice', 'sess_alice.db'))).toBe(true);
    expect(fs.existsSync(path.join(payloadDir, 'ag_bob'))).toBe(false);
  });

  it('writes a payload row when a request flows through the proxy', async () => {
    _resetForTest();
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', payloadDir);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Attribution now comes from the container token, not the spoofable
    // group/session headers — mint a real token for this (group, session).
    const token = mintContainerToken('ag1', 'sess1');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'x-nanoclaw-agent-token': token,
          'content-type': 'application/json',
        },
      },
      JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );

    // Give the 'end' event a tick to fire
    await new Promise((r) => setTimeout(r, 50));

    const dbPath = path.join(payloadDir, 'ag1', 'sess1.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT seq, upstream_route, response_status FROM payloads').all() as Array<{
      seq: number;
      upstream_route: string;
      response_status: number | null;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].upstream_route).toBe('anthropic');
    expect(rows[0].response_status).toBe(200);
  });

  it('still forwards the request when payload-store write fails (bad payloadDir)', async () => {
    _resetForTest();
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', '/dev/null/not-a-dir');
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Mint a real token so a store open is actually attempted (and fails,
    // since the payloadDir is bogus) — otherwise this test would pass
    // trivially with no store lookup at all.
    const token = mintContainerToken('ag1', 'sess1');

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'x-nanoclaw-agent-token': token,
          'content-type': 'application/json',
        },
      },
      JSON.stringify({ model: 'claude', messages: [] }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('strips x-nanoclaw-session-id before forwarding upstream', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    // Override upstream to capture headers
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', payloadDir);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'x-nanoclaw-agent-group': 'ag1',
          'x-nanoclaw-session-id': 'sess1',
          'content-type': 'application/json',
        },
      },
      '{}',
    );

    expect(capturedHeaders['x-nanoclaw-session-id']).toBeUndefined();
  });

  // Fix C: pin the upstream token strip (credential-proxy.ts:636). The
  // capability token is a live credential — it must never reach an upstream
  // (Anthropic, OpenAI, omlx, clemson), same reasoning as the session-id
  // strip above, using the same upstream-capture mechanism.
  it('strips x-nanoclaw-agent-token before forwarding upstream', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0, '127.0.0.1', payloadDir);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    _resetForTest();
    const token = mintContainerToken('ag1', 'sess1');

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/anthropic/v1/messages',
        headers: {
          'x-nanoclaw-agent-token': token,
          'content-type': 'application/json',
        },
      },
      '{}',
    );

    expect(capturedHeaders['x-nanoclaw-agent-token']).toBeUndefined();
  });
});
