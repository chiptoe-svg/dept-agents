/**
 * End-to-end integration test for Task 16 (Phase X.7).
 *
 * Walks the full stack:
 *   registry → handleProviderAuthStart → handleProviderAuthExchange
 *   (mocked token exchanger) → storage → resolveUserCreds
 *   → userCredsHook → returns the student's OAuth access token.
 *
 * No network calls are made. Token exchanger and roster lookup are injected.
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
import { resolveUserCreds, setRosterLookupForTests } from '../user-provider-resolver.js';
import { loadUserProviderCreds } from '../user-provider-auth.js';

// Sanitised path: alice@x.edu → alice_x_edu (sanitizeUserIdForPath squashes all non-alphanum to _)
const CLEANUP_DIR = path.join(process.cwd(), 'data/user-provider-creds/alice_x_edu');

beforeAll(() => {
  setRosterLookupForTests((gid) => (gid === 'alice-gid' ? { userId: 'alice@x.edu', classId: 'default' } : null));
  setUserCredsHook(resolveUserCreds);
  setTokenExchangerForTests(async () => ({
    accessToken: 'integration-at',
    refreshToken: 'integration-rt',
    expiresIn: 3600,
    account: 'alice',
  }));
});

afterAll(() => {
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
