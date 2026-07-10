/**
 * Focused tests for the two MCP-transport pieces `buildContainerArgs` gained
 * alongside HTTP MCP support (see src/container-config.ts + src/mcp-header-env.ts):
 *
 *   1. A generic `-e` arg safety net that rewrites any literal
 *      `host.docker.internal` to the real bridge gateway (Apple Container
 *      VMs can't resolve it).
 *   2. Scoped forwarding of exactly the .env vars referenced as `${VAR}` in
 *      an MCP server's headers — never the whole .env — plus a loud warning
 *      (naming the var + server, never the value) when a referenced var is
 *      missing.
 *
 * `buildContainerArgs` itself does no DB or filesystem I/O beyond the
 * mocked-out helpers below, so this drives it directly rather than going
 * through the full spawnContainer path (see container-token-lifecycle.test.ts
 * for that end-to-end harness).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readEnvFile: vi.fn((keys: string[]) => ({}) as Record<string, string>),
  logWarn: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => mocks.readEnvFile(keys),
}));

vi.mock('./log.js', () => ({
  log: {
    info: vi.fn(),
    warn: (msg: string, data?: Record<string, unknown>) => mocks.logWarn(msg, data),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./web-search-config.js', () => ({
  readWebSearchProvider: vi.fn(() => 'brave'),
  readSearxngUrl: vi.fn(() => ''),
  readBraveApiKey: vi.fn(() => ''),
}));

vi.mock('./container-env-registry.js', () => ({
  collectContainerEnv: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: vi.fn(() => '192.168.65.1'),
  CONTAINER_RUNTIME_BIN: 'test-container-bin',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(),
}));

const { buildContainerArgs } = await import('./container-runner.js');
const { emptyConfig } = await import('./container-config.js');
import type { AgentGroup } from './types.js';
import type { ProviderContainerContribution } from './providers/provider-container-registry.js';

const agentGroup: AgentGroup = {
  id: 'ag-1',
  name: 'Test Group',
  folder: 'test-group',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

const noContribution: ProviderContainerContribution = {};

function envArgValue(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1);
    }
  }
  return undefined;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildContainerArgs — host.docker.internal rewrite in -e args', () => {
  it('rewrites a literal host.docker.internal in a per-group env override', async () => {
    const containerConfig = { ...emptyConfig(), env: { SOME_URL: 'http://host.docker.internal:9000/x' } };
    const { args } = await buildContainerArgs(
      [],
      'test-container',
      agentGroup,
      containerConfig,
      'claude',
      noContribution,
      undefined,
      'sess-1',
    );
    expect(envArgValue(args, 'SOME_URL')).toBe('http://192.168.65.1:9000/x');
  });

  it('leaves an env value without host.docker.internal untouched', async () => {
    const containerConfig = { ...emptyConfig(), env: { SOME_URL: 'http://example.com:9000/x' } };
    const { args } = await buildContainerArgs(
      [],
      'test-container',
      agentGroup,
      containerConfig,
      'claude',
      noContribution,
      undefined,
      'sess-1',
    );
    expect(envArgValue(args, 'SOME_URL')).toBe('http://example.com:9000/x');
  });
});

describe('buildContainerArgs — scoped MCP header-secret forwarding', () => {
  it('forwards exactly the referenced var when present in .env', async () => {
    mocks.readEnvFile.mockImplementation((keys: string[]) =>
      keys.includes('WIKI_MCP_TOKEN') ? { WIKI_MCP_TOKEN: 'sekret-value' } : ({} as Record<string, string>),
    );
    const containerConfig = {
      ...emptyConfig(),
      mcpServers: {
        wiki: { url: 'http://gc-wiki:8080/mcp', headers: { Authorization: 'Bearer ${WIKI_MCP_TOKEN}' } },
      },
    };
    const { args } = await buildContainerArgs(
      [],
      'test-container',
      agentGroup,
      containerConfig,
      'claude',
      noContribution,
      undefined,
      'sess-1',
    );
    expect(envArgValue(args, 'WIKI_MCP_TOKEN')).toBe('sekret-value');
  });

  it('forwards no extra env when no server has headers', async () => {
    const containerConfig = {
      ...emptyConfig(),
      mcpServers: { local: { command: 'bun', args: ['run', 'x.ts'] } },
    };
    const { args } = await buildContainerArgs(
      [],
      'test-container',
      agentGroup,
      containerConfig,
      'claude',
      noContribution,
      undefined,
      'sess-1',
    );
    expect(mocks.readEnvFile).not.toHaveBeenCalled();
    expect(envArgValue(args, 'WIKI_MCP_TOKEN')).toBeUndefined();
  });

  it('warns loudly naming the var and server when the referenced var is missing from .env, without logging the header value', async () => {
    mocks.readEnvFile.mockImplementation(() => ({}));
    const containerConfig = {
      ...emptyConfig(),
      mcpServers: {
        wiki: { url: 'http://gc-wiki:8080/mcp', headers: { Authorization: 'Bearer ${WIKI_MCP_TOKEN}' } },
      },
    };
    const { args } = await buildContainerArgs(
      [],
      'test-container',
      agentGroup,
      containerConfig,
      'claude',
      noContribution,
      undefined,
      'sess-1',
    );
    expect(envArgValue(args, 'WIKI_MCP_TOKEN')).toBeUndefined();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [warnMsg, warnData] = mocks.logWarn.mock.calls[0];
    expect(warnMsg).toMatch(/WIKI_MCP_TOKEN|missing/i);
    expect(warnData).toMatchObject({ envVar: 'WIKI_MCP_TOKEN', servers: ['wiki'] });
    // Never log the (unresolved) header value or a bearer literal.
    const serialized = JSON.stringify([warnMsg, warnData]);
    expect(serialized).not.toContain('Bearer ${WIKI_MCP_TOKEN}');
  });
});
