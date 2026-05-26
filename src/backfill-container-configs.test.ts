import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-backfill', GROUPS_DIR: '/tmp/nanoclaw-test-backfill/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-backfill';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from './db/index.js';
import { getAllContainerConfigs, getContainerConfig } from './db/container-configs.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';

function now(): string {
  return new Date().toISOString();
}

describe('backfillContainerConfigs', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('seeds a row from an on-disk container.json', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'group one',
      folder: 'group-one',
      agent_provider: null,
      created_at: now(),
    });
    fs.mkdirSync(`${TEST_DIR}/groups/group-one`, { recursive: true });
    fs.writeFileSync(
      `${TEST_DIR}/groups/group-one/container.json`,
      JSON.stringify({
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        skills: ['some-skill'],
        mcpServers: { foo: { command: 'bar' } },
        packages: { apt: ['ripgrep'], npm: [] },
        env: { FOO: 'bar' },
        allowedModels: [{ provider: 'claude', model: 'claude-sonnet-4-5' }],
      }),
    );

    // Drop any row migration 020 may have inserted (the agent_groups row had
    // no model column to migrate from in this test, so there should be none).
    getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run('ag-1');

    backfillContainerConfigs();

    const row = getContainerConfig('ag-1');
    expect(row).toBeDefined();
    expect(row!.provider).toBe('claude');
    expect(row!.model).toBe('claude-sonnet-4-5');
    expect(JSON.parse(row!.skills)).toEqual(['some-skill']);
    expect(JSON.parse(row!.mcp_servers)).toEqual({ foo: { command: 'bar' } });
    expect(JSON.parse(row!.packages_apt)).toEqual(['ripgrep']);
    expect(JSON.parse(row!.env)).toEqual({ FOO: 'bar' });
    expect(JSON.parse(row!.allowed_models)).toEqual([{ provider: 'claude', model: 'claude-sonnet-4-5' }]);
  });

  it('is idempotent — second call adds no rows and changes nothing', () => {
    createAgentGroup({
      id: 'ag-2',
      name: 'group two',
      folder: 'group-two',
      agent_provider: 'claude',
      created_at: now(),
    });
    // no container.json on disk — backfill seeds defaults
    getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run('ag-2');

    backfillContainerConfigs();
    const firstCount = getAllContainerConfigs().length;
    const firstRow = getContainerConfig('ag-2')!;

    backfillContainerConfigs();
    const secondCount = getAllContainerConfigs().length;
    const secondRow = getContainerConfig('ag-2')!;

    expect(secondCount).toBe(firstCount);
    expect(secondRow.updated_at).toBe(firstRow.updated_at);
  });

  it('agent_groups.agent_provider wins over file provider (matches old cascade)', () => {
    createAgentGroup({
      id: 'ag-3',
      name: 'group three',
      folder: 'group-three',
      agent_provider: 'pi',
      created_at: now(),
    });
    fs.mkdirSync(`${TEST_DIR}/groups/group-three`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/groups/group-three/container.json`, JSON.stringify({ provider: 'claude' }));
    getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run('ag-3');

    backfillContainerConfigs();

    expect(getContainerConfig('ag-3')!.provider).toBe('pi');
  });
});
