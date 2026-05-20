/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema, getInboundSourceSessionId, migrateMessagesInTable } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('ensureSchema (outbound) — idempotent cost-column upgrades', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-db-'));
    dbPath = path.join(tmp, 'outbound.db');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates messages_out with the new cost columns on a fresh DB', () => {
    ensureSchema(dbPath, 'outbound');
    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare('PRAGMA table_info(messages_out)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(cols).toContain('tokens_in');
    expect(cols).toContain('tokens_out');
    expect(cols).toContain('latency_ms');
    expect(cols).toContain('provider');
    expect(cols).toContain('model');
  });

  it('upgrades a pre-existing outbound.db that has the old schema', () => {
    // Simulate a Phase 3 / pre-v3 outbound.db by creating messages_out without the new columns.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE messages_out (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        in_reply_to    TEXT,
        timestamp      TEXT NOT NULL,
        deliver_after  TEXT,
        recurrence     TEXT,
        kind           TEXT NOT NULL,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    seed.close();

    // Now call ensureSchema — should add the missing columns without touching existing data.
    ensureSchema(dbPath, 'outbound');

    const db = new Database(dbPath, { readonly: true });
    const cols = (db.prepare('PRAGMA table_info(messages_out)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(cols).toContain('tokens_in');
    expect(cols).toContain('tokens_out');
    expect(cols).toContain('latency_ms');
    expect(cols).toContain('provider');
    expect(cols).toContain('model');
  });

  it('is idempotent — calling ensureSchema twice does not throw', () => {
    ensureSchema(dbPath, 'outbound');
    expect(() => ensureSchema(dbPath, 'outbound')).not.toThrow();
  });

  it('does not touch existing messages_out rows on upgrade', () => {
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE messages_out (
        id    TEXT PRIMARY KEY,
        seq   INTEGER UNIQUE,
        timestamp TEXT NOT NULL,
        kind  TEXT NOT NULL,
        content TEXT NOT NULL
      );
      INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('m1', 1, 't', 'chat', 'hello');
    `);
    seed.close();

    ensureSchema(dbPath, 'outbound');

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT id, content FROM messages_out WHERE id = ?').get('m1') as {
      id: string;
      content: string;
    };
    db.close();
    expect(row).toEqual({ id: 'm1', content: 'hello' });
  });
});
