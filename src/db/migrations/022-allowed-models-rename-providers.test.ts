/**
 * Tests for migration022 — allowed_models provider rename.
 *
 * Cases:
 *   1. Legacy 'claude' / 'codex' entries are remapped to 'anthropic' / 'openai-codex'.
 *   2. Already-remapped entries are left untouched (idempotency).
 *   3. Row with NULL allowed_models is left untouched.
 *   4. Row with provider: 'local' is left untouched (no remap rule).
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migration022 } from './022-allowed-models-rename-providers.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.prepare(
    `CREATE TABLE container_configs (
       agent_group_id TEXT PRIMARY KEY,
       allowed_models TEXT
     )`,
  ).run();
  return db;
}

function insertRow(db: Database.Database, id: string, allowedModels: string | null): void {
  db.prepare('INSERT INTO container_configs (agent_group_id, allowed_models) VALUES (?, ?)').run(id, allowedModels);
}

function getRow(db: Database.Database, id: string): { allowed_models: string | null } {
  return db.prepare('SELECT allowed_models FROM container_configs WHERE agent_group_id = ?').get(id) as {
    allowed_models: string | null;
  };
}

describe('migration022 — allowed_models provider rename', () => {
  it('remaps legacy claude/codex providers to anthropic/openai-codex', () => {
    const db = makeDb();
    insertRow(
      db,
      'ag-legacy',
      JSON.stringify([
        { provider: 'claude', model: 'claude-sonnet-4-5' },
        { provider: 'codex', model: 'gpt-5.4-mini' },
      ]),
    );

    migration022.up(db);

    const row = getRow(db, 'ag-legacy');
    const parsed = JSON.parse(row.allowed_models!) as { provider: string; model: string }[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(parsed[1]).toEqual({ provider: 'openai-codex', model: 'gpt-5.4-mini' });

    db.close();
  });

  it('is idempotent — already-remapped values are untouched on second run', () => {
    const db = makeDb();
    const already = JSON.stringify([
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    ]);
    insertRow(db, 'ag-already', already);

    migration022.up(db);
    migration022.up(db); // second run

    const row = getRow(db, 'ag-already');
    expect(row.allowed_models).toBe(already);

    db.close();
  });

  it('leaves rows with NULL allowed_models untouched', () => {
    const db = makeDb();
    insertRow(db, 'ag-null', null);

    migration022.up(db);

    const row = getRow(db, 'ag-null');
    expect(row.allowed_models).toBeNull();

    db.close();
  });

  it('leaves rows with provider: local untouched (no remap rule)', () => {
    const db = makeDb();
    const local = JSON.stringify([{ provider: 'local', model: 'Qwen3.6-35B-MLX-4bit' }]);
    insertRow(db, 'ag-local', local);

    migration022.up(db);

    const row = getRow(db, 'ag-local');
    expect(row.allowed_models).toBe(local);

    db.close();
  });
});
