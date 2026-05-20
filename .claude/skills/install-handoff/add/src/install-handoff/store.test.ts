import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { moduleInstallHandoffs } from '../db/migrations/module-install-handoffs.js';

describe('install-handoff store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    moduleInstallHandoffs.up(db);
    vi.doMock('../db/connection.js', () => ({ getDb: () => db }));
  });

  afterEach(() => {
    db.close();
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const defaultFiles = [
    { name: '.env', size: 512 },
    { name: 'gws/credentials.json', size: 1024 },
  ];

  async function store() {
    return import('./store.js');
  }

  // ---------------------------------------------------------------------------
  // issueHandoff
  // ---------------------------------------------------------------------------

  it('issueHandoff mints a 32-char hex token and 16-char hex id, persists hashed token', async () => {
    const { issueHandoff } = await store();
    const result = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });

    expect(result.token).toMatch(/^[a-f0-9]{32}$/);
    expect(result.id).toMatch(/^[a-f0-9]{16}$/);
    expect(result.expiresAt).toBeTruthy();

    const row = db.prepare('SELECT * FROM install_handoffs WHERE id = ?').get(result.id) as {
      token_hash: string;
      current_uses: number;
      max_uses: number;
      files_json: string;
      revoked_at: string | null;
    };
    // Raw token is NOT stored.
    expect(row.token_hash).not.toBe(result.token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(row.current_uses).toBe(0);
    expect(row.max_uses).toBe(1);
    expect(JSON.parse(row.files_json)).toEqual(defaultFiles);
    expect(row.revoked_at).toBeNull();
  });

  it('issueHandoff produces unique tokens across two calls', async () => {
    const { issueHandoff } = await store();
    const a = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const b = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  // ---------------------------------------------------------------------------
  // getHandoff
  // ---------------------------------------------------------------------------

  it('getHandoff returns ok=true for a valid token', async () => {
    const { issueHandoff, getHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const result = getHandoff(issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe(issued.id);
    expect(result.files).toEqual(defaultFiles);
    expect(result.current_uses).toBe(0);
    expect(result.max_uses).toBe(1);
  });

  it('getHandoff returns reason=unknown-token for a nonexistent token', async () => {
    const { getHandoff } = await store();
    const result = getHandoff('deadbeef'.repeat(4));
    expect(result).toEqual({ ok: false, reason: 'unknown-token' });
  });

  it('getHandoff returns reason=expired for a past expires_at', async () => {
    const { issueHandoff, getHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    db.prepare('UPDATE install_handoffs SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      issued.id,
    );
    const result = getHandoff(issued.token);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('getHandoff returns reason=revoked when revoked_at is set', async () => {
    const { issueHandoff, getHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    db.prepare('UPDATE install_handoffs SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      issued.id,
    );
    const result = getHandoff(issued.token);
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('getHandoff returns reason=exhausted when current_uses >= max_uses', async () => {
    const { issueHandoff, getHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 2, files: defaultFiles });
    db.prepare('UPDATE install_handoffs SET current_uses = 2 WHERE id = ?').run(issued.id);
    const result = getHandoff(issued.token);
    expect(result).toEqual({ ok: false, reason: 'exhausted' });
  });

  // ---------------------------------------------------------------------------
  // consumeHandoff
  // ---------------------------------------------------------------------------

  it('consumeHandoff increments current_uses by 1', async () => {
    const { issueHandoff, consumeHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 3, files: defaultFiles });
    const result = consumeHandoff(issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.current_uses).toBe(1);

    const row = db.prepare('SELECT current_uses FROM install_handoffs WHERE id = ?').get(issued.id) as {
      current_uses: number;
    };
    expect(row.current_uses).toBe(1);
  });

  it('consumeHandoff on the max_uses-th use increments AND sets revoked_at', async () => {
    const { issueHandoff, consumeHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const result = consumeHandoff(issued.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.current_uses).toBe(1);

    const row = db.prepare('SELECT current_uses, revoked_at FROM install_handoffs WHERE id = ?').get(
      issued.id,
    ) as { current_uses: number; revoked_at: string | null };
    expect(row.current_uses).toBe(1);
    expect(row.revoked_at).not.toBeNull();
  });

  it('consumeHandoff after exhaustion returns a failure result', async () => {
    const { issueHandoff, consumeHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    consumeHandoff(issued.token); // exhausts on first call
    const result = consumeHandoff(issued.token); // second call should fail
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // revokeHandoff
  // ---------------------------------------------------------------------------

  it('revokeHandoff marks revoked_at and returns true', async () => {
    const { issueHandoff, revokeHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const revoked = revokeHandoff(issued.id);
    expect(revoked).toBe(true);

    const row = db.prepare('SELECT revoked_at FROM install_handoffs WHERE id = ?').get(issued.id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
  });

  it('revokeHandoff returns false for an unknown id', async () => {
    const { revokeHandoff } = await store();
    expect(revokeHandoff('does-not-exist')).toBe(false);
  });

  it('revokeHandoff is idempotent — returns false on second call', async () => {
    const { issueHandoff, revokeHandoff } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    expect(revokeHandoff(issued.id)).toBe(true);
    expect(revokeHandoff(issued.id)).toBe(false); // already revoked
  });

  // ---------------------------------------------------------------------------
  // listHandoffs
  // ---------------------------------------------------------------------------

  it('listHandoffs returns rows with correct derived status fields', async () => {
    const { issueHandoff, revokeHandoff, listHandoffs } = await store();
    const a = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const b = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: [{ name: '.env', size: 100 }] });

    // Expire row a
    db.prepare('UPDATE install_handoffs SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      a.id,
    );
    // Revoke row b
    revokeHandoff(b.id);

    const rows = listHandoffs();
    expect(rows.length).toBe(2);

    // Look up each row by id — don't assume insertion order when timestamps may tie.
    const rowA = rows.find((r) => r.id === a.id);
    const rowB = rows.find((r) => r.id === b.id);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.status).toBe('expired');
    expect(rowB!.status).toBe('revoked');
  });

  it('listHandoffs shows active status for a live handoff', async () => {
    const { issueHandoff, listHandoffs } = await store();
    issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    const rows = listHandoffs();
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.files_count).toBe(2);
  });

  it('listHandoffs shows exhausted status when max_uses consumed', async () => {
    const { issueHandoff, consumeHandoff, listHandoffs } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    consumeHandoff(issued.token);
    const rows = listHandoffs();
    expect(rows[0]!.status).toBe('exhausted');
  });

  // ---------------------------------------------------------------------------
  // sweepExpiredHandoffs
  // ---------------------------------------------------------------------------

  it('sweepExpiredHandoffs deletes expired rows and returns count', async () => {
    const { issueHandoff, sweepExpiredHandoffs } = await store();
    const issued = issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });
    // Keep one active row
    issueHandoff({ ttlMs: 60_000, maxUses: 1, files: defaultFiles });

    // Force row to be expired
    db.prepare('UPDATE install_handoffs SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      issued.id,
    );
    const dropped = sweepExpiredHandoffs();
    expect(dropped).toBe(1);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM install_handoffs').get() as { c: number };
    expect(remaining.c).toBe(1); // active row survives
  });

  it('sweepExpiredHandoffs deletes revoked-more-than-1h-ago rows', async () => {
    const { issueHandoff, sweepExpiredHandoffs } = await store();
    const issued = issueHandoff({ ttlMs: 60_000 * 24, maxUses: 1, files: defaultFiles });
    // Mark as revoked 2h ago (outside grace window)
    db.prepare('UPDATE install_handoffs SET revoked_at = ? WHERE id = ?').run(
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      issued.id,
    );
    const dropped = sweepExpiredHandoffs();
    expect(dropped).toBe(1);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM install_handoffs').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('sweepExpiredHandoffs keeps recently-revoked rows (inside 1h grace)', async () => {
    const { issueHandoff, revokeHandoff, sweepExpiredHandoffs } = await store();
    const issued = issueHandoff({ ttlMs: 60_000 * 24, maxUses: 1, files: defaultFiles });
    revokeHandoff(issued.id); // revoked_at = now (within 1h)
    const dropped = sweepExpiredHandoffs();
    expect(dropped).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM install_handoffs').get() as { c: number };
    expect(remaining.c).toBe(1); // still there for audit
  });
});
