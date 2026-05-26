/**
 * Unit tests for `recoverSingleOutboundDb` — the per-DB primitive used by
 * `recoverStaleOutboundJournals` at host startup to clear stale SQLite
 * `-journal` files left by a crashed R/W writer (otherwise the first readonly
 * open trips SQLITE_READONLY_ROLLBACK).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverSingleOutboundDb } from './session-manager.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-recovery-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createOutboundDbWithSchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.prepare('CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER, content TEXT)').run();
  db.close();
}

function createStaleJournal(dbPath: string): void {
  // Bytes don't need to be a real journal — SQLite just needs to SEE the file
  // to trigger its recovery path on next open. The R/W open then rolls it back
  // (or nukes it if recovery isn't possible).
  fs.writeFileSync(`${dbPath}-journal`, Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]));
}

describe('recoverSingleOutboundDb', () => {
  it('removes a stale -journal file by opening RW briefly', () => {
    const dbPath = path.join(tmpRoot, 'outbound.db');
    createOutboundDbWithSchema(dbPath);
    createStaleJournal(dbPath);
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(true);

    const r = recoverSingleOutboundDb(dbPath);

    expect(r).toEqual({ existed: true, recovered: true, failed: false });
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(false);
  });

  it('returns existed=false when the DB file is missing (no error)', () => {
    const r = recoverSingleOutboundDb(path.join(tmpRoot, 'nonexistent.db'));
    expect(r).toEqual({ existed: false, recovered: false, failed: false });
  });

  it('returns recovered=false when the DB exists but has no journal', () => {
    const dbPath = path.join(tmpRoot, 'outbound.db');
    createOutboundDbWithSchema(dbPath);

    const r = recoverSingleOutboundDb(dbPath);

    expect(r).toEqual({ existed: true, recovered: false, failed: false });
  });

  it('returns failed=true (without throwing) when the file is not a valid SQLite DB', () => {
    const dbPath = path.join(tmpRoot, 'outbound.db');
    fs.writeFileSync(dbPath, 'this is not a valid sqlite db file');

    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = recoverSingleOutboundDb(dbPath);
    consoleErr.mockRestore();

    expect(r).toEqual({ existed: true, recovered: false, failed: true });
  });
});
