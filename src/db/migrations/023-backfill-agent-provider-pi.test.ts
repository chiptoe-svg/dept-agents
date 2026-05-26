/**
 * Tests for migration023 — backfill agent_provider to 'pi'.
 *
 * Cases:
 *   1. Rows with agent_provider='claude' are rewritten to 'pi'.
 *   2. Rows with agent_provider='codex' are rewritten to 'pi'.
 *   3. Rows with agent_provider='pi' are left unchanged.
 *   4. Rows with NULL agent_provider are left unchanged.
 *   5. Idempotent — second run is a no-op.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migration023 } from './023-backfill-agent-provider-pi.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.prepare(
    `CREATE TABLE agent_groups (
       id TEXT PRIMARY KEY,
       agent_provider TEXT
     )`,
  ).run();
  return db;
}

function insertRow(db: Database.Database, id: string, provider: string | null): void {
  db.prepare('INSERT INTO agent_groups (id, agent_provider) VALUES (?, ?)').run(id, provider);
}

function getProvider(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT agent_provider FROM agent_groups WHERE id = ?').get(id) as {
    agent_provider: string | null;
  };
  return row.agent_provider;
}

describe('migration023 — backfill agent_provider to pi', () => {
  it('rewrites claude to pi', () => {
    const db = makeDb();
    insertRow(db, 'ag-claude', 'claude');

    migration023.up(db);

    expect(getProvider(db, 'ag-claude')).toBe('pi');
    db.close();
  });

  it('rewrites codex to pi', () => {
    const db = makeDb();
    insertRow(db, 'ag-codex', 'codex');

    migration023.up(db);

    expect(getProvider(db, 'ag-codex')).toBe('pi');
    db.close();
  });

  it('leaves pi rows unchanged', () => {
    const db = makeDb();
    insertRow(db, 'ag-pi', 'pi');

    migration023.up(db);

    expect(getProvider(db, 'ag-pi')).toBe('pi');
    db.close();
  });

  it('leaves NULL rows unchanged', () => {
    const db = makeDb();
    insertRow(db, 'ag-null', null);

    migration023.up(db);

    expect(getProvider(db, 'ag-null')).toBeNull();
    db.close();
  });

  it('is idempotent — second run is a no-op', () => {
    const db = makeDb();
    insertRow(db, 'ag-claude', 'claude');
    insertRow(db, 'ag-codex', 'codex');

    migration023.up(db);
    migration023.up(db); // second run

    expect(getProvider(db, 'ag-claude')).toBe('pi');
    expect(getProvider(db, 'ag-codex')).toBe('pi');
    db.close();
  });
});
