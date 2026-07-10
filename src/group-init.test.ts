import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-group-init',
    GROUPS_DIR: '/tmp/nanoclaw-test-group-init/groups',
    DEFAULT_MCP_SERVERS_PATH: '/tmp/nanoclaw-test-group-init/config/default-mcp-servers.json',
  };
});

const TMP = '/tmp/nanoclaw-test-group-init';
const GROUPS = path.join(TMP, 'groups');
const DEFAULT_MCP_SERVERS_PATH = path.join(TMP, 'config', 'default-mcp-servers.json');

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { initGroupFilesystem, readDefaultMcpServers } from './group-init.js';
import type { AgentGroup } from './types.js';

function makeGroup(id: string, folder: string): AgentGroup {
  const group = {
    id,
    name: id,
    folder,
    agent_provider: 'pi',
    created_at: '2026-01-01',
  } as AgentGroup;
  createAgentGroup(group);
  return group;
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  fs.mkdirSync(path.dirname(DEFAULT_MCP_SERVERS_PATH), { recursive: true });
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readDefaultMcpServers', () => {
  it('reads and parses the config file', () => {
    fs.writeFileSync(
      DEFAULT_MCP_SERVERS_PATH,
      JSON.stringify({ 'fake-server': { url: 'http://host.docker.internal:9999/' } }),
    );
    expect(readDefaultMcpServers()).toEqual({
      'fake-server': { url: 'http://host.docker.internal:9999/' },
    });
  });

  it('returns {} when the file is absent', () => {
    expect(readDefaultMcpServers()).toEqual({});
  });

  it('returns {} when the file is malformed', () => {
    fs.writeFileSync(DEFAULT_MCP_SERVERS_PATH, '{ not valid json');
    expect(readDefaultMcpServers()).toEqual({});
  });
});

describe('initGroupFilesystem seeds mcp_servers from the default config', () => {
  it('a newly-created group gets the default servers', () => {
    fs.writeFileSync(
      DEFAULT_MCP_SERVERS_PATH,
      JSON.stringify({ 'fake-server': { url: 'http://host.docker.internal:9999/' } }),
    );
    const group = makeGroup('ag_test1', 'test_folder_1');
    initGroupFilesystem(group);

    const row = getContainerConfig(group.id);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.mcp_servers)).toEqual({
      'fake-server': { url: 'http://host.docker.internal:9999/' },
    });
  });

  it('an absent/malformed default config still succeeds, with mcp_servers {}', () => {
    // No default-mcp-servers.json written — file absent.
    const group = makeGroup('ag_test2', 'test_folder_2');
    expect(() => initGroupFilesystem(group)).not.toThrow();

    const row = getContainerConfig(group.id);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.mcp_servers)).toEqual({});
  });

  it('does not overwrite an existing non-empty mcp_servers on re-init', () => {
    fs.writeFileSync(
      DEFAULT_MCP_SERVERS_PATH,
      JSON.stringify({ 'fake-server': { url: 'http://host.docker.internal:9999/' } }),
    );
    const group = makeGroup('ag_test3', 'test_folder_3');
    initGroupFilesystem(group);

    // Re-init should be a no-op for an already-seeded config row, even if
    // the default config file changes underneath it.
    fs.writeFileSync(
      DEFAULT_MCP_SERVERS_PATH,
      JSON.stringify({ 'other-server': { url: 'http://host.docker.internal:1111/' } }),
    );
    initGroupFilesystem(group);

    const row = getContainerConfig(group.id);
    expect(JSON.parse(row!.mcp_servers)).toEqual({
      'fake-server': { url: 'http://host.docker.internal:9999/' },
    });
  });
});
