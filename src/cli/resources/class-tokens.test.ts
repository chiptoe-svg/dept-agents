/**
 * Dispatch-level tests for `ncl class-tokens issue|rotate|revoke` user
 * resolution (Plan 3 final-review Fix 1).
 *
 * The department flow provisions users via `ncl users provision`, which
 * stores the email in agent_groups.metadata and writes NO classroom_roster
 * row. These tests pin the two resolution paths that flow depends on:
 *   - `--user-id <id>` works directly with no roster row at all, and
 *   - `--email <email>` falls back to the agent_groups metadata email
 *     (case-insensitive) when the roster has no match.
 *
 * Uses a temp DB + GROUPS_DIR (same pattern as users-provision.test.ts) so
 * nothing touches the real install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports — wrap TMP in vi.hoisted
// (established pattern, see users-provision.test.ts).
const { TMP } = vi.hoisted(() => ({ TMP: '/tmp/nanoclaw-test-class-tokens' }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});
// urlFor() reads PUBLIC_PLAYGROUND_URL from env; stub with fake data rather
// than touching the real .env.
vi.stubEnv('PUBLIC_PLAYGROUND_URL', 'http://example.test:8088');

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect imports: register the commands under test.
import './class-tokens.js';
import './users.js';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'groups'), { recursive: true });
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function seedUser(id: string): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'playground', 'Someone', new Date().toISOString());
}

function activeTokenCount(userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM class_login_tokens WHERE user_id = ? AND revoked_at IS NULL')
    .get(userId) as { n: number };
  return row.n;
}

describe('class-tokens --user-id (no roster row)', () => {
  it('rotate mints a fresh token for a bare user with no roster entry', async () => {
    seedUser('playground:someone');
    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-rotate', args: { 'user-id': 'playground:someone' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { user_id: string; url: string } }).data;
    expect(data.user_id).toBe('playground:someone');
    expect(data.url).toMatch(/^http:\/\/example\.test:8088\/\?token=[0-9a-f]{48}$/);
    expect(activeTokenCount('playground:someone')).toBe(1);
  });

  it('rotate revokes prior tokens before minting the new one', async () => {
    seedUser('playground:someone');
    await dispatch(
      { id: 'r1', command: 'class-tokens-issue', args: { 'user-id': 'playground:someone' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'r2', command: 'class-tokens-rotate', args: { 'user-id': 'playground:someone' } },
      { caller: 'host' },
    );
    expect(activeTokenCount('playground:someone')).toBe(1);
    const total = getDb()
      .prepare("SELECT COUNT(*) AS n FROM class_login_tokens WHERE user_id = 'playground:someone'")
      .get() as { n: number };
    expect(total.n).toBe(2);
  });

  it('revoke kills every active token via --user-id', async () => {
    seedUser('playground:someone');
    await dispatch(
      { id: 'r1', command: 'class-tokens-issue', args: { 'user-id': 'playground:someone' } },
      { caller: 'host' },
    );
    const resp = await dispatch(
      { id: 'r2', command: 'class-tokens-revoke', args: { 'user-id': 'playground:someone' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { revoked: number } }).data.revoked).toBe(1);
    expect(activeTokenCount('playground:someone')).toBe(0);
  });

  it('rejects a --user-id that does not exist (no token minted for typos)', async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-issue', args: { 'user-id': 'playground:ghost' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('No user with id playground:ghost');
    expect(activeTokenCount('playground:ghost')).toBe(0);
  });
});

describe('class-tokens --email metadata fallback (provisioned users)', () => {
  async function provisionDana(): Promise<string> {
    const resp = await dispatch(
      { id: 'p1', command: 'users-provision', args: { 'display-name': 'Dana Faculty', email: 'dana@example.test' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    return (resp as { ok: true; data: { userId: string } }).data.userId;
  }

  it('issue --email resolves via agent_groups metadata when roster is empty', async () => {
    const userId = await provisionDana();
    // Precondition of the department flow: provision wrote no roster row.
    const roster = getDb().prepare('SELECT COUNT(*) AS n FROM classroom_roster').get() as { n: number };
    expect(roster.n).toBe(0);

    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-issue', args: { email: 'dana@example.test' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { user_id: string; url: string } }).data;
    expect(data.user_id).toBe(userId);
    expect(data.url).toMatch(/^http:\/\/example\.test:8088\/\?token=[0-9a-f]{48}$/);
  });

  it('matches the metadata email case-insensitively', async () => {
    const userId = await provisionDana();
    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-rotate', args: { email: 'Dana@Example.TEST' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { user_id: string } }).data.user_id).toBe(userId);
  });

  it('prefers a classroom_roster match over the metadata fallback', async () => {
    await provisionDana();
    seedUser('playground:roster_dana');
    getDb()
      .prepare('INSERT INTO classroom_roster (email, user_id, agent_group_id, added_at) VALUES (?, ?, NULL, ?)')
      .run('dana@example.test', 'playground:roster_dana', new Date().toISOString());

    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-issue', args: { email: 'dana@example.test' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { user_id: string } }).data.user_id).toBe('playground:roster_dana');
  });

  it('fails cleanly when neither roster nor metadata knows the email', async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'class-tokens-revoke', args: { email: 'ghost@example.test' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('No user found for email ghost@example.test');
  });

  it('requires --user-id or --email', async () => {
    const resp = await dispatch({ id: 'r1', command: 'class-tokens-issue', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('--user-id or --email is required');
  });
});
