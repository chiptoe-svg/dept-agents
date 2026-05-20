import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  type AppServer,
  type JsonRpcServerRequest,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  tomlBasicString,
  writeCodexConfigToml,
} from './codex-app-server.js';

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

describe('Codex CLI pin contract', () => {
  it('keeps app-server behind a concrete pinned @openai/codex install', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const dockerfile = fs.readFileSync(path.resolve(testDir, '../../../Dockerfile'), 'utf-8');

    const versionMatch = dockerfile.match(/^ARG CODEX_VERSION=(.+)$/m);
    expect(versionMatch).not.toBeNull();
    expect(versionMatch![1]).not.toBe('latest');
    expect(versionMatch![1]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain('pnpm install -g "@openai/codex@${CODEX_VERSION}"');
  });
});

describe('attachCodexAutoApproval', () => {
  function fakeServer(): { server: AppServer; writes: string[] } {
    const writes: string[] = [];
    const server = {
      process: {
        stdin: {
          write: (line: string) => {
            writes.push(line);
            return true;
          },
        },
      },
      pending: new Map(),
      notificationHandlers: [],
      serverRequestHandlers: [],
    } as unknown as AppServer;

    return { server, writes };
  }

  function send(server: AppServer, method: string): void {
    const request: JsonRpcServerRequest = { id: 7, method, params: {} };
    server.serverRequestHandlers[0](request);
  }

  it('auto-accepts command and file approvals inside the container sandbox', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    send(server, 'item/commandExecution/requestApproval');
    send(server, 'item/fileChange/requestApproval');

    expect(writes.map((line) => JSON.parse(line).result.decision)).toEqual(['accept', 'accept']);
  });

  it('grants broad app-server permissions because NanoClaw relies on container mounts as the boundary', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    send(server, 'item/permissions/requestApproval');

    const result = JSON.parse(writes[0]).result;
    expect(result).toEqual({
      permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
      scope: 'session',
    });
  });
});

let tmpHome: string;
let savedHome: string | undefined;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-test-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
  configPath = path.join(tmpHome, '.codex', 'config.toml');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('writeCodexConfigToml — codex provider', () => {
  it('emits [model_providers.openai-custom] block plus top-level model / model_provider', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'codex',
      model: 'gpt-5-mini',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.openai-custom]');
    expect(toml).toContain('name = "openai-custom"');
    expect(toml).toContain('base_url = "http://host.docker.internal:3001/openai/v1"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('model = "gpt-5-mini"');
    expect(toml).toContain('model_provider = "openai-custom"');
    expect(toml).not.toContain('[model_providers.omlx]');
  });
});

describe('writeCodexConfigToml — local provider', () => {
  it('emits [model_providers.omlx] block plus top-level model / model_provider', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'local',
      model: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.omlx]');
    expect(toml).toContain('name = "omlx"');
    expect(toml).toContain('base_url = "http://host.docker.internal:3001/omlx/v1"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).toContain('env_key = "OMLX_API_KEY"');
    expect(toml).toContain('model = "Qwen3.6-35B-A3B-UD-MLX-4bit"');
    expect(toml).toContain('model_provider = "omlx"');
    expect(toml).not.toContain('[model_providers.openai-custom]');
  });
});

describe('writeCodexConfigToml — mcp servers still emitted', () => {
  it('writes both [mcp_servers.*] and the active [model_providers.*] in one file', () => {
    writeCodexConfigToml({
      mcpServers: {
        nanoclaw: { command: '/usr/bin/bun', args: ['run', '/app/src/mcp.ts'], env: { FOO: 'bar' } },
      },
      activeProvider: 'codex',
      model: 'gpt-5-mini',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.nanoclaw]');
    expect(toml).toContain('[model_providers.openai-custom]');
    expect(toml).toContain('FOO = "bar"');
  });
});

describe('writeCodexConfigToml — model omitted', () => {
  it('still emits [model_providers.<name>] block when no model is set', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'local',
      model: undefined,
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.omlx]');
    // model_provider must still be set so codex routes to omlx
    expect(toml).toContain('model_provider = "omlx"');
    // model line is omitted when not set — codex falls back to its own default
    expect(toml).not.toMatch(/^model = /m);
  });
});
