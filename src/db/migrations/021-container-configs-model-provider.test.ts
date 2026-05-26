/**
 * Tests for migration021 — container_configs.model_provider column.
 *
 * Tests:
 *   1. Column is added (migration runs without error, column appears in PRAGMA).
 *   2. Backfill: rows with NANOCLAW_PI_MODEL_PROVIDER in env get model_provider populated.
 *   3. Backfill: rows without the env key remain NULL.
 *   4. Idempotency: re-running the migration up() does nothing (column already exists).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, getDb } from '../index.js';
import { migration021 } from './021-container-configs-model-provider.js';

function now(): string {
  return new Date().toISOString();
}

/** Create the minimal tables needed for migration021 in a fresh in-memory DB. */
function createMinimalSchema(db: Database.Database): void {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL)',
  ).run();
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name)',
  ).run();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS container_configs (
       agent_group_id TEXT PRIMARY KEY,
       provider TEXT, model TEXT, effort TEXT, image_tag TEXT, assistant_name TEXT,
       max_messages_per_prompt INTEGER,
       skills TEXT NOT NULL DEFAULT '"all"',
       mcp_servers TEXT NOT NULL DEFAULT '{}',
       packages_apt TEXT NOT NULL DEFAULT '[]',
       packages_npm TEXT NOT NULL DEFAULT '[]',
       additional_mounts TEXT NOT NULL DEFAULT '[]',
       cli_scope TEXT NOT NULL DEFAULT 'group',
       env TEXT NOT NULL DEFAULT '{}',
       allowed_models TEXT NOT NULL DEFAULT '[]',
       updated_at TEXT NOT NULL
     )`,
  ).run();
}

function insertConfigRow(db: Database.Database, agentGroupId: string, envJson: string): void {
  db.prepare(
    `INSERT INTO container_configs
       (agent_group_id, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, cli_scope, env, allowed_models, updated_at)
     VALUES (?, '"all"', '{}', '[]', '[]', '[]', 'group', ?, '[]', ?)`,
  ).run(agentGroupId, envJson, now());
}

describe('migration021 — container_configs.model_provider', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('adds the model_provider column to container_configs', () => {
    const cols = getDb()
      .prepare('PRAGMA table_info(container_configs)')
      .all() as { name: string }[];
    expect(cols.some((c) => c.name === 'model_provider')).toBe(true);
  });

  it('is idempotent — re-running up() when column already exists does not throw', () => {
    const db = getDb();
    expect(() => migration021.up(db)).not.toThrow();
    const cols = db
      .prepare('PRAGMA table_info(container_configs)')
      .all() as { name: string }[];
    expect(cols.some((c) => c.name === 'model_provider')).toBe(true);
  });

  it('backfills model_provider from NANOCLAW_PI_MODEL_PROVIDER in env', () => {
    const freshDb = new Database(':memory:');
    createMinimalSchema(freshDb);

    const envWithKey = JSON.stringify({ NANOCLAW_PI_MODEL_PROVIDER: 'openai', KEEP: 'yes' });
    const envWithoutKey = JSON.stringify({ UNRELATED: 'val' });
    const envEmpty = '{}';

    insertConfigRow(freshDb, 'ag-with-key', envWithKey);
    insertConfigRow(freshDb, 'ag-without-key', envWithoutKey);
    insertConfigRow(freshDb, 'ag-empty-env', envEmpty);

    migration021.up(freshDb);

    const withKey = freshDb
      .prepare('SELECT model_provider FROM container_configs WHERE agent_group_id = ?')
      .get('ag-with-key') as { model_provider: string | null };
    const withoutKey = freshDb
      .prepare('SELECT model_provider FROM container_configs WHERE agent_group_id = ?')
      .get('ag-without-key') as { model_provider: string | null };
    const emptyEnv = freshDb
      .prepare('SELECT model_provider FROM container_configs WHERE agent_group_id = ?')
      .get('ag-empty-env') as { model_provider: string | null };

    expect(withKey.model_provider).toBe('openai');
    expect(withoutKey.model_provider).toBeNull();
    expect(emptyEnv.model_provider).toBeNull();

    freshDb.close();
  });

  it('backfill leaves rows with anthropic value intact', () => {
    const freshDb = new Database(':memory:');
    createMinimalSchema(freshDb);

    const env = JSON.stringify({ NANOCLAW_PI_MODEL_PROVIDER: 'anthropic' });
    insertConfigRow(freshDb, 'ag-anthropic', env);

    migration021.up(freshDb);

    const row = freshDb
      .prepare('SELECT model_provider FROM container_configs WHERE agent_group_id = ?')
      .get('ag-anthropic') as { model_provider: string | null };
    expect(row.model_provider).toBe('anthropic');

    freshDb.close();
  });
});
