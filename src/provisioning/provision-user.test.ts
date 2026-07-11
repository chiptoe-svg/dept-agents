import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts declared below them — wrap TMP in vi.hoisted (established pattern,
// see src/web-search-config.test.ts).
const { TMP } = vi.hoisted(() => ({ TMP: '/tmp/nanoclaw-test-provision' }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TMP, GROUPS_DIR: path.join(TMP, 'groups') };
});
// publicPlaygroundBaseUrl() reads PUBLIC_PLAYGROUND_URL from env; set it for the test.
vi.stubEnv('PUBLIC_PLAYGROUND_URL', 'http://example.test:8088');

import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { getAgentGroupByFolder, getPlaygroundAgentForUser } from '../db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { provisionUser } from './provision-user.js';

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

describe('provisionUser', () => {
  it('creates a fully-wired, isolated user with a login URL', () => {
    const r = provisionUser({ displayName: 'Dana Faculty', email: 'dana@clemson.edu' });
    expect(r.userId).toMatch(/^playground:/);
    expect(r.loginUrl).toContain('example.test');
    expect(r.loginUrl).toMatch(/\?token=[A-Za-z0-9_-]+$/);
    // own group resolves via membership (Task 1)
    expect(getPlaygroundAgentForUser(r.userId)?.id).toBe(r.agentGroupId);
    expect(isMember(r.userId, r.agentGroupId)).toBe(true);
    // container_configs seeded with provider=pi (the Plan-1 footgun)
    const cfg = getDb()
      .prepare('SELECT provider, model, model_provider FROM container_configs WHERE agent_group_id=?')
      .get(r.agentGroupId) as { provider: string; model: string; model_provider: string };
    expect(cfg.provider).toBe('pi');
    expect(cfg.model).toBe('qwen3.6-35b-a3b-fp8');
    expect(cfg.model_provider).toBe('clemson');
    // filesystem scaffolded
    expect(fs.existsSync(path.join(TMP, 'groups', r.folder))).toBe(true);
    // routing gate: messaging group must be 'public', not 'strict' — the
    // playground route hardcodes a synthetic senderId that 'strict' would
    // reject, dropping every inbound message at the router's access gate.
    const mg = getMessagingGroupByPlatform('playground', `playground:${r.folder}`);
    expect(mg?.unknown_sender_policy).toBe('public');
  });

  it('refuses to double-provision the same identity', () => {
    provisionUser({ displayName: 'Dana', email: 'dana@clemson.edu' });
    expect(() => provisionUser({ displayName: 'Dana', email: 'dana@clemson.edu' })).toThrow(/exists/i);
  });

  it('does not leak another user’s agent', () => {
    const a = provisionUser({ displayName: 'A', email: 'a@clemson.edu' });
    const b = provisionUser({ displayName: 'B', email: 'b@clemson.edu' });
    expect(getPlaygroundAgentForUser(a.userId)?.id).toBe(a.agentGroupId);
    expect(getPlaygroundAgentForUser(b.userId)?.id).toBe(b.agentGroupId);
    expect(a.agentGroupId).not.toBe(b.agentGroupId);
  });
});
