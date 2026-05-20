import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

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

import {
  startCredentialProxy,
  setStudentCredsHook,
  studentCredsHook,
  serializeResolvedCredsError,
} from './credential-proxy.js';

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
        path: '/v1/messages',
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
        path: '/api/oauth/claude_cli/create_api_key',
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
        path: '/v1/messages',
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
        path: '/v1/messages',
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
        path: '/v1/messages',
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
        path: '/api/oauth/claude_cli/create_api_key',
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
        path: '/v1/messages',
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
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
});

describe('studentCredsHook', () => {
  afterEach(() => {
    setStudentCredsHook(async () => null);
  });

  it('default hook returns null (no-op for solo installs)', async () => {
    const result = await studentCredsHook('any-gid', 'claude');
    expect(result).toBeNull();
  });

  it('setStudentCredsHook installs a new hook globally', async () => {
    setStudentCredsHook(async (gid, provider) => ({
      kind: 'apiKey',
      value: `key-for-${gid}-${provider}`,
    }));
    const result = await studentCredsHook('g1', 'claude');
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
