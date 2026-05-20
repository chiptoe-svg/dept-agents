import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { moduleClassEnrollmentPasscode } from './db/migrations/module-class-enrollment-passcode.js';

describe('class-enrollment-passcode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // The migration also alters classroom_roster; create it first.
    db.exec(`
      CREATE TABLE classroom_roster (
        email          TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        agent_group_id TEXT,
        added_at       INTEGER NOT NULL
      );
    `);
    moduleClassEnrollmentPasscode.up(db);
    vi.doMock('./db/connection.js', () => ({ getDb: () => db }));
  });

  afterEach(() => {
    db.close();
    vi.resetModules();
  });

  it('rotatePasscode returns a 4-digit string', async () => {
    const { rotatePasscode } = await import('./class-enrollment-passcode.js');
    const code = rotatePasscode('owner:1');
    expect(code).toMatch(/^\d{4}$/);
  });

  it('rotatePasscode persists hash+salt to DB', async () => {
    const { rotatePasscode } = await import('./class-enrollment-passcode.js');
    rotatePasscode('owner:1');
    const row = db.prepare('SELECT passcode_hash, passcode_salt FROM class_enrollment_passcodes').get() as
      | {
          passcode_hash: string;
          passcode_salt: string;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.passcode_hash).toMatch(/^[a-f0-9]+$/);
    expect(row!.passcode_salt).toMatch(/^[a-f0-9]+$/);
  });

  it('getCurrentPasscodeCleartext returns the code right after rotation', async () => {
    const { rotatePasscode, getCurrentPasscodeCleartext } = await import('./class-enrollment-passcode.js');
    const code = rotatePasscode('owner:1');
    const cached = getCurrentPasscodeCleartext();
    expect(cached).toBe(code);
  });

  it('getCurrentPasscodeCleartext returns null before any rotation', async () => {
    const { getCurrentPasscodeCleartext } = await import('./class-enrollment-passcode.js');
    expect(getCurrentPasscodeCleartext()).toBeNull();
  });

  it('verifyPasscode accepts the current code', async () => {
    const { rotatePasscode, verifyPasscode } = await import('./class-enrollment-passcode.js');
    const code = rotatePasscode('owner:1');
    expect(verifyPasscode(code)).toBe(true);
  });

  it('verifyPasscode rejects a wrong code', async () => {
    const { rotatePasscode, verifyPasscode } = await import('./class-enrollment-passcode.js');
    rotatePasscode('owner:1');
    // All-zeros is astronomically unlikely to collide with a random 4-digit code.
    expect(verifyPasscode('0000')).toBe(false);
  });

  it('verifyPasscode rejects after a second rotation invalidates the old code', async () => {
    const { rotatePasscode, verifyPasscode } = await import('./class-enrollment-passcode.js');
    const oldCode = rotatePasscode('owner:1');
    const newCode = rotatePasscode('owner:1');

    // New code works.
    expect(verifyPasscode(newCode)).toBe(true);
    // Old code no longer matches the new hash (they're different random codes).
    // Tiny collision risk — if oldCode === newCode the test would be vacuous,
    // but with 4-digit space the odds are 1/10000 per run.
    if (oldCode !== newCode) {
      expect(verifyPasscode(oldCode)).toBe(false);
    }
  });

  it('verifyPasscode returns false when no passcode exists', async () => {
    const { verifyPasscode } = await import('./class-enrollment-passcode.js');
    expect(verifyPasscode('1234')).toBe(false);
  });

  it('table holds at most one row after multiple rotations', async () => {
    const { rotatePasscode } = await import('./class-enrollment-passcode.js');
    rotatePasscode('owner:1');
    rotatePasscode('owner:1');
    rotatePasscode('owner:1');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM class_enrollment_passcodes').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
