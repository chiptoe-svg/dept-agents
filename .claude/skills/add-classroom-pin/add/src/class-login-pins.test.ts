import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { moduleClassLoginPins } from './db/migrations/module-class-login-pins.js';

describe('class-login-pins', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Stand up the class_login_tokens schema (from /add-classroom) so issuePin can
    // verify token rows. Use the same shape as the upstream migration.
    db.exec(`
      CREATE TABLE class_login_tokens (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
    `);
    moduleClassLoginPins.up(db);
    vi.doMock('./db/connection.js', () => ({ getDb: () => db }));
  });

  afterEach(() => {
    db.close();
    vi.resetModules();
  });

  function seedToken(token: string, userId: string, revoked = false): void {
    db.prepare(
      'INSERT INTO class_login_tokens (token, user_id, created_at, revoked_at) VALUES (?, ?, ?, ?)',
    ).run(token, userId, new Date().toISOString(), revoked ? new Date().toISOString() : null);
  }

  it('issuePin mints a 6-digit PIN and persists hash+salt', async () => {
    seedToken('tok-1', 'class:alice');
    const { issuePin } = await import('./class-login-pins.js');
    const result = issuePin('tok-1', 'class:alice', 'alice@school.edu');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pin).toMatch(/^\d{6}$/);
    expect(result.pendingId).toMatch(/^[a-f0-9]{32}$/);

    const row = db.prepare('SELECT * FROM class_login_pins WHERE id = ?').get(result.pendingId) as {
      pin_hash: string;
      pin_salt: string;
      attempts: number;
      used_at: string | null;
    };
    expect(row.pin_hash).toMatch(/^[a-f0-9]+$/);
    expect(row.pin_salt).toMatch(/^[a-f0-9]+$/);
    expect(row.attempts).toBe(0);
    expect(row.used_at).toBeNull();
  });

  it('issuePin rejects unknown tokens', async () => {
    const { issuePin } = await import('./class-login-pins.js');
    const result = issuePin('does-not-exist', 'class:alice', 'alice@school.edu');
    expect(result).toEqual({ ok: false, reason: 'unknown-token' });
  });

  it('issuePin rejects revoked tokens', async () => {
    seedToken('tok-revoked', 'class:bob', true);
    const { issuePin } = await import('./class-login-pins.js');
    const result = issuePin('tok-revoked', 'class:bob', 'bob@school.edu');
    expect(result).toEqual({ ok: false, reason: 'token-revoked' });
  });

  it('verifyPin succeeds with matching PIN, marks used', async () => {
    seedToken('tok-2', 'class:carol');
    const { issuePin, verifyPin } = await import('./class-login-pins.js');
    const issued = issuePin('tok-2', 'class:carol', 'carol@school.edu');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const result = verifyPin(issued.pendingId, issued.pin);
    expect(result).toEqual({ ok: true, userId: 'class:carol' });

    const row = db.prepare('SELECT used_at FROM class_login_pins WHERE id = ?').get(issued.pendingId) as {
      used_at: string | null;
    };
    expect(row.used_at).not.toBeNull();
  });

  it('verifyPin rejects wrong PIN, increments attempts', async () => {
    seedToken('tok-3', 'class:dave');
    const { issuePin, verifyPin } = await import('./class-login-pins.js');
    const issued = issuePin('tok-3', 'class:dave', 'dave@school.edu');
    if (!issued.ok) return;
    const result = verifyPin(issued.pendingId, '000000');
    expect(result).toEqual({ ok: false, reason: 'wrong-pin' });

    const row = db.prepare('SELECT attempts FROM class_login_pins WHERE id = ?').get(issued.pendingId) as {
      attempts: number;
    };
    expect(row.attempts).toBe(1);
  });

  it('verifyPin rate-limits after 3 wrong attempts', async () => {
    seedToken('tok-4', 'class:eve');
    const { issuePin, verifyPin } = await import('./class-login-pins.js');
    const issued = issuePin('tok-4', 'class:eve', 'eve@school.edu');
    if (!issued.ok) return;
    verifyPin(issued.pendingId, '000000');
    verifyPin(issued.pendingId, '000000');
    verifyPin(issued.pendingId, '000000');
    // The 4th attempt — even if it's the right PIN — should be rate-limited.
    const result = verifyPin(issued.pendingId, issued.pin);
    expect(result).toEqual({ ok: false, reason: 'rate-limited' });
  });

  it('verifyPin rejects expired PIN', async () => {
    seedToken('tok-5', 'class:frank');
    const { issuePin, verifyPin } = await import('./class-login-pins.js');
    const issued = issuePin('tok-5', 'class:frank', 'frank@school.edu');
    if (!issued.ok) return;
    // Force-expire the row.
    db.prepare('UPDATE class_login_pins SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      issued.pendingId,
    );
    const result = verifyPin(issued.pendingId, issued.pin);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('verifyPin rejects already-used PIN', async () => {
    seedToken('tok-6', 'class:gina');
    const { issuePin, verifyPin } = await import('./class-login-pins.js');
    const issued = issuePin('tok-6', 'class:gina', 'gina@school.edu');
    if (!issued.ok) return;
    verifyPin(issued.pendingId, issued.pin); // first use — succeeds
    const result = verifyPin(issued.pendingId, issued.pin);
    expect(result).toEqual({ ok: false, reason: 'used' });
  });

  it('verifyPin rejects unknown pendingId', async () => {
    const { verifyPin } = await import('./class-login-pins.js');
    const result = verifyPin('deadbeef'.repeat(4), '123456');
    expect(result).toEqual({ ok: false, reason: 'unknown-pending' });
  });

  it('sweepExpiredPins drops expired and used rows older than 1h', async () => {
    seedToken('tok-7', 'class:helen');
    const { issuePin, sweepExpiredPins } = await import('./class-login-pins.js');
    const issued = issuePin('tok-7', 'class:helen', 'helen@school.edu');
    if (!issued.ok) return;
    // Force-expire to 2h ago so the sweep catches it.
    db.prepare('UPDATE class_login_pins SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      issued.pendingId,
    );
    const dropped = sweepExpiredPins();
    expect(dropped).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM class_login_pins').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
