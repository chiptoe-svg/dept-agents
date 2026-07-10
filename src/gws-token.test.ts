/**
 * Tests for getGoogleAccessTokenForAgentGroup.
 *
 * Strategy: mock fs.existsSync + fs.readFileSync so readGwsCredentialsFromPath
 * returns controlled objects with a fresh access_token (so no HTTPS refresh is
 * needed), mock getAgentGroupMetadata + studentGwsCredentialsPath so we control
 * whether a per-group credentials file "exists". This exercises the real
 * production logic without hitting the network or the real filesystem.
 *
 * The instructor/owner credentials path is seeded in these fixtures too, but
 * only to prove it is NEVER read on behalf of another group — there is no
 * fallback to it. See the "security-critical" test below.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- hoisted mock state -------------------------------------------------------
// All variables used inside vi.mock factories must be created with vi.hoisted
// so they exist before the factories run (factories are hoisted to file top).
const { mockExistsSync, mockReadFileSync, mockGetAgentGroupMetadata } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockGetAgentGroupMetadata: vi.fn(),
}));

// --- module mocks -------------------------------------------------------------

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroupMetadata: mockGetAgentGroupMetadata,
}));

vi.mock('./student-creds-paths.js', () => ({
  studentGwsCredentialsPath: (uid: string) => `/fake/student/${uid}/credentials.json`,
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    default: { ...real, existsSync: mockExistsSync, readFileSync: mockReadFileSync },
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

// --- imports ------------------------------------------------------------------

import {
  getGoogleAccessTokenForAgentGroup,
  INSTRUCTOR_GWS_CREDENTIALS_PATH,
  _resetTokenCacheForTest,
} from './gws-token.js';

// --- constants ----------------------------------------------------------------

const STUDENT_TOKEN = 'student-access-token';
const INSTRUCTOR_TOKEN = 'instructor-access-token';

// A credentials object whose access_token is fresh for 1 hour — so
// getGoogleAccessTokenForCredsPath returns the access_token immediately,
// without any HTTPS refresh.
function makeFreshCreds(accessToken: string): string {
  return JSON.stringify({
    type: 'authorized_user',
    client_id: 'cid',
    client_secret: 'csecret',
    refresh_token: 'rtoken',
    access_token: accessToken,
    expiry_date: Date.now() + 60 * 60 * 1000, // 1 h from now
  });
}

const STUDENT_CREDS_PATH = '/fake/student/user-42/credentials.json';

/** Configure mocks so the per-student lookup succeeds. */
function withStudentToken() {
  mockGetAgentGroupMetadata.mockReturnValue({ student_user_id: 'user-42' });
  mockExistsSync.mockImplementation((p) => {
    const s = String(p);
    return s === STUDENT_CREDS_PATH || s === INSTRUCTOR_GWS_CREDENTIALS_PATH;
  });
  mockReadFileSync.mockImplementation((p) => {
    const s = String(p);
    if (s === STUDENT_CREDS_PATH) return makeFreshCreds(STUDENT_TOKEN);
    if (s === INSTRUCTOR_GWS_CREDENTIALS_PATH) return makeFreshCreds(INSTRUCTOR_TOKEN);
    throw new Error(`readFileSync: unexpected path ${s}`);
  });
}

/** Configure mocks so the per-student lookup fails (no creds file on disk). */
function withoutStudentToken() {
  mockGetAgentGroupMetadata.mockReturnValue({ student_user_id: 'user-42' });
  mockExistsSync.mockImplementation((p) => String(p) === INSTRUCTOR_GWS_CREDENTIALS_PATH);
  mockReadFileSync.mockImplementation((p) => {
    const s = String(p);
    if (s === INSTRUCTOR_GWS_CREDENTIALS_PATH) return makeFreshCreds(INSTRUCTOR_TOKEN);
    throw new Error(`readFileSync: unexpected path ${s}`);
  });
}

// --- tests --------------------------------------------------------------------

describe('getGoogleAccessTokenForAgentGroup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetTokenCacheForTest();
  });

  it('returns null when agentGroupId is null', async () => {
    mockExistsSync.mockImplementation((p) => String(p) === INSTRUCTOR_GWS_CREDENTIALS_PATH);
    mockReadFileSync.mockReturnValue(makeFreshCreds(INSTRUCTOR_TOKEN));

    const result = await getGoogleAccessTokenForAgentGroup(null);

    expect(result).toBeNull();
    // Instructor credentials must never be consulted — there is no fallback.
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('resolves to its own token when a group has personal credentials', async () => {
    withStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1');

    expect(result).toEqual({ token: STUDENT_TOKEN, principal: 'self' });
  });

  // Security-critical: a group with no personal Google credentials of its
  // own must resolve to null — never the owner/instructor's token. This is
  // the mutation-tested assertion (see task report for the RED proof with
  // the fallback branch restored).

  it('resolves to null — NOT the owner/instructor token — when a group has no personal credentials', async () => {
    withoutStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1');

    expect(result).toBeNull();
    // Instructor credentials must never be read on behalf of a group that
    // isn't the owner's — the fallback path must not exist at all.
    expect(mockReadFileSync).not.toHaveBeenCalledWith(INSTRUCTOR_GWS_CREDENTIALS_PATH, 'utf-8');
  });
});
