import { describe, expect, it, vi } from 'vitest';

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: vi.fn(() => '192.168.65.1'),
}));

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

function baseRow(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    env: null,
    allowed_models: null,
    model_provider: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as ContainerConfigRow;
}

const group: AgentGroup = {
  id: 'ag-1',
  name: 'Test Group',
  folder: 'test-group',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('configFromDb — MCP server host.docker.internal gateway rewrite', () => {
  it('rewrites host.docker.internal in an MCP server url to the bridge gateway', () => {
    const row = baseRow({
      mcp_servers: JSON.stringify({
        wiki: { url: 'http://host.docker.internal:8766/' },
      }),
    });
    const cfg = configFromDb(row, group);
    expect(cfg.mcpServers.wiki.url).toBe('http://192.168.65.1:8766/');
  });

  it('leaves a url without host.docker.internal untouched', () => {
    const row = baseRow({
      mcp_servers: JSON.stringify({
        wiki: { url: 'http://example.com:8766/' },
      }),
    });
    const cfg = configFromDb(row, group);
    expect(cfg.mcpServers.wiki.url).toBe('http://example.com:8766/');
  });

  it('leaves stdio servers (no url) untouched', () => {
    const row = baseRow({
      mcp_servers: JSON.stringify({
        local: { command: 'bun', args: ['run', 'x.ts'] },
      }),
    });
    const cfg = configFromDb(row, group);
    expect(cfg.mcpServers.local).toEqual({ command: 'bun', args: ['run', 'x.ts'], url: undefined });
  });
});

describe('configFromDb — invalid MCP server config', () => {
  it('throws naming the server when neither command nor url is set', () => {
    const row = baseRow({
      mcp_servers: JSON.stringify({
        broken: { args: ['x'] },
      }),
    });
    expect(() => configFromDb(row, group)).toThrow(/broken/);
  });
});
