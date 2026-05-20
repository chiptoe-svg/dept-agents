/**
 * Tests for getGoogleAccessTokenForAgentGroup (and the requirePersonal gate).
 *
 * Strategy: mock fs.existsSync + fs.readFileSync so readGwsCredentialsFromPath
 * returns controlled objects with a fresh access_token (so no HTTPS refresh is
 * needed), mock getAgentGroupMetadata + studentGwsCredentialsPath so we control
 * whether a per-student credentials file "exists".  This exercises the real
 * production logic — including the instructor-fallback chain — without hitting
 * the network or the real filesystem.
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

  // ── Row 1: agentGroupId=null, requirePersonal=false (default) ──────────────

  it('returns instructor token when agentGroupId is null and requirePersonal is false (default)', async () => {
    mockExistsSync.mockImplementation((p) => String(p) === INSTRUCTOR_GWS_CREDENTIALS_PATH);
    mockReadFileSync.mockReturnValue(makeFreshCreds(INSTRUCTOR_TOKEN));

    const result = await getGoogleAccessTokenForAgentGroup(null);

    expect(result).toEqual({ token: INSTRUCTOR_TOKEN, principal: 'instructor-fallback' });
  });

  it('returns null when agentGroupId is null and instructor token is also unavailable', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await getGoogleAccessTokenForAgentGroup(null);

    expect(result).toBeNull();
  });

  // ── Row 2: agentGroupId=null, requirePersonal=true ─────────────────────────

  it('returns null when agentGroupId is null and requirePersonal is true (instructor not consulted)', async () => {
    mockExistsSync.mockImplementation((p) => String(p) === INSTRUCTOR_GWS_CREDENTIALS_PATH);
    mockReadFileSync.mockReturnValue(makeFreshCreds(INSTRUCTOR_TOKEN));

    const result = await getGoogleAccessTokenForAgentGroup(null, { requirePersonal: true });

    // Short-circuit fires before the instructor path is read.
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  // ── Row 3: agentGroupId set, per-student found ─────────────────────────────

  it('returns student token when per-student lookup succeeds (requirePersonal false)', async () => {
    withStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1');

    expect(result).toEqual({ token: STUDENT_TOKEN, principal: 'self' });
  });

  it('returns student token when per-student lookup succeeds (requirePersonal true)', async () => {
    withStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1', { requirePersonal: true });

    expect(result).toEqual({ token: STUDENT_TOKEN, principal: 'self' });
  });

  // ── Row 4: agentGroupId set, per-student NOT found, requirePersonal=false ──

  it('falls back to instructor token when per-student lookup fails and requirePersonal is false', async () => {
    withoutStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1');

    expect(result).toEqual({ token: INSTRUCTOR_TOKEN, principal: 'instructor-fallback' });
  });

  // ── Row 5: agentGroupId set, per-student NOT found, requirePersonal=true ───

  it('returns null when per-student lookup fails and requirePersonal is true (no instructor fallback)', async () => {
    withoutStudentToken();

    const result = await getGoogleAccessTokenForAgentGroup('group-1', { requirePersonal: true });

    expect(result).toBeNull();
    // Instructor credentials must not have been read at all.
    expect(mockReadFileSync).not.toHaveBeenCalledWith(INSTRUCTOR_GWS_CREDENTIALS_PATH, 'utf-8');
  });
});
