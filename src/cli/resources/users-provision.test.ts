/**
 * Dispatch-level test for `ncl users provision` (Task 3, Plan 3).
 *
 * Exercises the actual registered `users-provision` verb through dispatch(),
 * not provisionUser() directly — removing the registration in
 * src/cli/resources/users.ts fails this test, not just a provision-user.ts
 * regression (which src/provisioning/provision-user.test.ts already covers).
 *
 * Also asserts the registered access level is 'approval', not 'open' — a
 * future edit that loosens it must fail CI (see task brief's critical
 * security requirement).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts declared below them — wrap TMP in vi.hoisted (established pattern,
// see src/provisioning/provision-user.test.ts).
const { TMP } = vi.hoisted(() => ({ TMP: '/tmp/nanoclaw-test-users-provision' }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});
// publicPlaygroundBaseUrl() reads PUBLIC_PLAYGROUND_URL from env; stub it
// with fake data rather than touching the real .env.
vi.stubEnv('PUBLIC_PLAYGROUND_URL', 'http://example.test:8088');

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getResource } from '../crud.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `users-*` commands, including the
// custom `provision` verb under test.
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

describe('users-provision (dispatch)', () => {
  it('provisions a user through the dispatcher and returns a login URL', async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'users-provision', args: { 'display-name': 'Dana Faculty', email: 'dana@example.test' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { userId: string; agentGroupId: string; loginUrl: string } }).data;
    expect(data.loginUrl).toMatch(/^http:\/\/example\.test:8088\/\?token=[A-Za-z0-9_-]+$/);
    expect(data.userId).toMatch(/^playground:/);
    expect(data.agentGroupId).toBeTruthy();

    // The user now exists in the DB (not just returned by the handler).
    const row = getDb().prepare('SELECT id, display_name FROM users WHERE id = ?').get(data.userId) as
      | { id: string; display_name: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row?.display_name).toBe('Dana Faculty');
  });

  it('is registered with access "approval", never "open"', () => {
    const def = getResource('users');
    expect(def).toBeTruthy();
    const provisionOp = def?.customOperations?.provision;
    expect(provisionOp).toBeTruthy();
    expect(provisionOp?.access).toBe('approval');
    expect(provisionOp?.access).not.toBe('open');
  });
});
