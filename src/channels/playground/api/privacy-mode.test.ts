import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the container-runtime side effect so tests don't need a real spawned
// container. `getActiveSessions` stays real (backed by the in-memory test
// DB) so the "only recycle the caller's own group" assertion is meaningful.
vi.mock('../../../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { createUser } from '../../../modules/permissions/db/users.js';
import { addMember } from '../../../modules/permissions/db/agent-group-members.js';
import { createAgentGroup, getAgentGroupMetadata } from '../../../db/agent-groups.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { createSession } from '../../../db/sessions.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
} from '../../../db/container-configs.js';
import { getAppConfig } from '../../../db/app-config.js';
import { isContainerRunning, killContainer } from '../../../container-runner.js';
import type { PlaygroundSession } from '../auth-store.js';
import { handlePrivacyMode } from './privacy-mode.js';

const NOW = '2026-07-10T00:00:00Z';
const CLOUD = { provider: 'clemson', model: 'qwen3.6-35b-a3b-fp8' };
const PRIVATE = { provider: 'local', model: 'Qwen3.6-35B-A3B-UD-MLX-4bit' };

function sess(userId: string | null, cookieValue = 'c'): PlaygroundSession {
  return { userId, cookieValue, createdAt: 0, lastActivityAt: 0 };
}

function seedGroup(id: string, folder: string, userId?: string): void {
  createAgentGroup({ id, name: id, folder, agent_provider: 'pi', created_at: NOW, metadata: '{}' });
  ensureContainerConfig(id);
  if (userId) {
    createUser({ id: userId, kind: 'playground', display_name: null, created_at: NOW });
    addMember({ user_id: userId, agent_group_id: id, added_by: null, added_at: NOW });
  }
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer).mockClear();
});
afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('handlePrivacyMode', () => {
  it('going private stashes the current cloud choice and sets the private pair', () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });

    const r = handlePrivacyMode(sess('playground:alice'), { private: true });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ private: true, provider: PRIVATE.provider });
    const cc = getContainerConfig('ag_alice');
    expect(cc?.model_provider).toBe(PRIVATE.provider);
    expect(cc?.model).toBe(PRIVATE.model);
    expect(getAgentGroupMetadata('ag_alice').cloudChoice).toEqual(CLOUD);
  });

  it('going cloud after a stash restores the stashed cloud choice', () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });
    handlePrivacyMode(sess('playground:alice'), { private: true });

    const r = handlePrivacyMode(sess('playground:alice'), { private: false });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ private: false, provider: CLOUD.provider });
    const cc = getContainerConfig('ag_alice');
    expect(cc?.model_provider).toBe(CLOUD.provider);
    expect(cc?.model).toBe(CLOUD.model);
  });

  it('going cloud with no stash falls back to the department default cloud pair', () => {
    seedGroup('ag_bob', 'user_bob', 'playground:bob');
    // Never went private, so metadata.cloudChoice was never stashed. Start
    // the group on the private pair to prove the fallback actually fires
    // (not just a no-op restore of an already-correct value).
    updateContainerConfigScalars('ag_bob', { model_provider: PRIVATE.provider, model: PRIVATE.model });

    const r = handlePrivacyMode(sess('playground:bob'), { private: false });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ private: false, provider: getAppConfig('default_cloud_provider') });
    const cc = getContainerConfig('ag_bob');
    expect(cc?.model_provider).toBe(getAppConfig('default_cloud_provider'));
    expect(cc?.model).toBe(getAppConfig('default_cloud_model'));
    expect(cc?.model_provider).toBe(CLOUD.provider);
    expect(cc?.model).toBe(CLOUD.model);
  });

  it("ignores a body-supplied folder and only mutates the caller's own group", () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    seedGroup('ag_other', 'user_other', 'playground:other');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });
    updateContainerConfigScalars('ag_other', { model_provider: CLOUD.provider, model: CLOUD.model });

    const r = handlePrivacyMode(sess('playground:alice'), { private: true, folder: 'user_other' } as never);

    expect(r.status).toBe(200);
    const alice = getContainerConfig('ag_alice');
    expect(alice?.model_provider).toBe(PRIVATE.provider);
    expect(alice?.model).toBe(PRIVATE.model);
    // The "other" group named in the body must be untouched.
    const other = getContainerConfig('ag_other');
    expect(other?.model_provider).toBe(CLOUD.provider);
    expect(other?.model).toBe(CLOUD.model);
  });

  it('returns 401 when the caller has no agent group (signed in, no membership)', () => {
    createUser({ id: 'playground:nobody', kind: 'playground', display_name: null, created_at: NOW });
    const r = handlePrivacyMode(sess('playground:nobody'), { private: true });
    expect(r.status).toBe(401);
  });

  it('returns 401 when the caller is not signed in', () => {
    const r = handlePrivacyMode(sess(null), { private: true });
    expect(r.status).toBe(401);
  });

  it("returns 409 when the caller's group has no container config row", () => {
    createAgentGroup({
      id: 'ag_nocc',
      name: 'nocc',
      folder: 'user_nocc',
      agent_provider: 'pi',
      created_at: NOW,
      metadata: '{}',
    });
    createUser({ id: 'playground:nocc', kind: 'playground', display_name: null, created_at: NOW });
    addMember({ user_id: 'playground:nocc', agent_group_id: 'ag_nocc', added_by: null, added_at: NOW });
    // Deliberately skip ensureContainerConfig.

    const r = handlePrivacyMode(sess('playground:nocc'), { private: true });
    expect(r.status).toBe(409);
  });

  it('returns 409 without writing when the department model config is missing', () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });
    getDb().prepare("DELETE FROM app_config WHERE key = 'private_model'").run();

    const r = handlePrivacyMode(sess('playground:alice'), { private: true });

    expect(r.status).toBe(409);
    const cc = getContainerConfig('ag_alice');
    expect(cc?.model_provider).toBe(CLOUD.provider);
    expect(cc?.model).toBe(CLOUD.model);
  });

  it("best-effort recycles only the caller's own running container, never another group's", () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    seedGroup('ag_other', 'user_other', 'playground:other');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });
    createMessagingGroup({
      id: 'mg_alice',
      channel_type: 'playground',
      platform_id: 'mg_alice',
      name: 'alice',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: NOW,
    });
    createMessagingGroup({
      id: 'mg_other',
      channel_type: 'playground',
      platform_id: 'mg_other',
      name: 'other',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: NOW,
    });
    createSession({
      id: 'sess_alice',
      agent_group_id: 'ag_alice',
      messaging_group_id: 'mg_alice',
      thread_id: null,
      agent_provider: 'pi',
      status: 'active',
      container_status: 'running',
      last_active: NOW,
      created_at: NOW,
    });
    createSession({
      id: 'sess_other',
      agent_group_id: 'ag_other',
      messaging_group_id: 'mg_other',
      thread_id: null,
      agent_provider: 'pi',
      status: 'active',
      container_status: 'running',
      last_active: NOW,
      created_at: NOW,
    });
    vi.mocked(isContainerRunning).mockReturnValue(true);

    handlePrivacyMode(sess('playground:alice'), { private: true });

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(killContainer).mock.calls[0]?.[0]).toBe('sess_alice');
  });

  it('does not block the response when the recycle call throws', () => {
    seedGroup('ag_alice', 'user_alice', 'playground:alice');
    updateContainerConfigScalars('ag_alice', { model_provider: CLOUD.provider, model: CLOUD.model });
    createMessagingGroup({
      id: 'mg_alice',
      channel_type: 'playground',
      platform_id: 'mg_alice',
      name: 'alice',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: NOW,
    });
    createSession({
      id: 'sess_alice',
      agent_group_id: 'ag_alice',
      messaging_group_id: 'mg_alice',
      thread_id: null,
      agent_provider: 'pi',
      status: 'active',
      container_status: 'running',
      last_active: NOW,
      created_at: NOW,
    });
    vi.mocked(isContainerRunning).mockReturnValue(true);
    vi.mocked(killContainer).mockImplementation(() => {
      throw new Error('runtime unavailable');
    });

    const r = handlePrivacyMode(sess('playground:alice'), { private: true });

    expect(r.status).toBe(200);
    const cc = getContainerConfig('ag_alice');
    expect(cc?.model_provider).toBe(PRIVATE.provider);
  });
});
