/**
 * End-to-end integration test for Task 16 (Phase X.7).
 *
 * Walks the full stack:
 *   registry → handleProviderAuthStart → handleProviderAuthExchange
 *   (mocked token exchanger) → storage → resolveUserCreds
 *   → userCredsHook → returns the user's OAuth access token.
 *
 * No network calls are made. Token exchanger is injected; the user is
 * resolved from a real agent_group_members row (the entity model).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import '../providers/claude-spec.js';
import {
  handleProviderAuthStart,
  handleProviderAuthExchange,
  setTokenExchangerForTests,
} from '../channels/playground/api/provider-auth.js';
import { setUserCredsHook, userCredsHook } from '../credential-proxy.js';
import { resolveUserCreds } from '../user-provider-resolver.js';
import { loadUserProviderCreds } from '../user-provider-auth.js';
import { initTestDb, closeDb, runMigrations, getDb } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createUser } from '../modules/permissions/db/users.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';

// Sanitised path: alice@x.edu → alice_x_edu (sanitizeUserIdForPath squashes all non-alphanum to _)
const CLEANUP_DIR = path.join(process.cwd(), 'data/user-provider-creds/alice_x_edu');

const NOW = '2026-07-10T00:00:00Z';

beforeAll(() => {
  initTestDb();
  runMigrations(getDb());
  createUser({ id: 'alice@x.edu', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({
    id: 'alice-gid',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'alice@x.edu', agent_group_id: 'alice-gid', added_by: null, added_at: NOW });
  setUserCredsHook(resolveUserCreds);
  setTokenExchangerForTests(async () => ({
    accessToken: 'integration-at',
    refreshToken: 'integration-rt',
    expiresIn: 3600,
    account: 'alice',
  }));
});

afterAll(() => {
  closeDb();
  fs.rmSync(CLEANUP_DIR, { recursive: true, force: true });
});

describe('end-to-end provider auth', () => {
  it('start → exchange → resolver → proxy hook returns student OAuth token', async () => {
    // Step 1: initiate OAuth flow
    const start = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    expect(start.status).toBe(200);
    const { state } = start.body as { state: string };

    // Step 2: exchange the auth code — uses the injected token exchanger
    const exchange = await handleProviderAuthExchange('claude', { code: 'good', state }, { userId: 'alice@x.edu' });
    expect(exchange.status).toBe(200);

    // Step 3: verify storage wrote the access token
    expect(loadUserProviderCreds('alice@x.edu', 'claude')?.oauth?.accessToken).toBe('integration-at');

    // Step 4: verify the proxy hook returns the student's OAuth token
    const result = await userCredsHook('alice-gid', 'claude');
    expect(result).toEqual({ kind: 'oauth', accessToken: 'integration-at' });
  });
});
