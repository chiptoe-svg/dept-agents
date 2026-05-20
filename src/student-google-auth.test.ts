/**
 * Unit tests for src/student-google-auth.ts.
 *
 * Filesystem isolation: vi.mock redirects studentGwsCredentialsPath to
 * return paths under a per-test tmp directory so real tests never touch
 * `data/` on disk. The mock is hoisted before module import so the
 * module under test picks it up at load time.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub logging so test output stays clean.
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture tmpDir before the factory runs so the factory closure can
// close over it. We reassign per-test in beforeEach; the factory reads
// `tmpDir` at call time, so assignments before each test are visible.
let tmpDir = '';

vi.mock('./student-creds-paths.js', () => ({
  sanitizeUserIdForPath: (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, '_'),
  studentGwsCredentialsPath: (userId: string) => {
    const sanitized = userId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(tmpDir, 'student-google-auth', sanitized, 'credentials.json');
  },
}));

import type { GwsCredentialsJson } from './gws-auth.js';
import {
  clearStudentCredentials,
  hasStudentCredentials,
  loadStudentCredentials,
  writeStudentCredentials,
} from './student-google-auth.js';
import { studentGwsCredentialsPath } from './student-creds-paths.js';

const SAMPLE_CREDS: GwsCredentialsJson = {
  type: 'authorized_user',
  client_id: 'client-id-123',
  client_secret: 'client-secret-456',
  refresh_token: 'refresh-token-789',
  access_token: 'access-token-abc',
  token_type: 'Bearer',
  expiry_date: 9999999999000,
  scope: 'openid https://www.googleapis.com/auth/drive',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ─── writeStudentCredentials ─────────────────────────────────────────────────

describe('writeStudentCredentials', () => {
  it('creates the directory tree and the file with correct contents', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);

    const credPath = path.join(tmpDir, 'student-google-auth', 'user_test01', 'credentials.json');
    expect(fs.existsSync(credPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as GwsCredentialsJson;
    expect(parsed.client_id).toBe('client-id-123');
    expect(parsed.client_secret).toBe('client-secret-456');
    expect(parsed.refresh_token).toBe('refresh-token-789');
    expect(parsed.access_token).toBe('access-token-abc');
    expect(parsed.type).toBe('authorized_user');
  });

  it('file mode is 0o600', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    const credPath = path.join(tmpDir, 'student-google-auth', 'user_test01', 'credentials.json');
    const mode = fs.statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tmp file is gone after write (atomic rename succeeded)', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    const dir = path.join(tmpDir, 'student-google-auth', 'user_test01');
    const files = fs.readdirSync(dir);
    // Only credentials.json should remain — no .tmp-* residue
    expect(files).toEqual(['credentials.json']);
  });

  it('overwrites an existing file', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);

    const updated: GwsCredentialsJson = { ...SAMPLE_CREDS, refresh_token: 'new-refresh-token' };
    writeStudentCredentials('user:test01', updated);

    const credPath = path.join(tmpDir, 'student-google-auth', 'user_test01', 'credentials.json');
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as GwsCredentialsJson;
    expect(parsed.refresh_token).toBe('new-refresh-token');
  });

  it('directory mode is 0o700', () => {
    writeStudentCredentials('user_dirmode', SAMPLE_CREDS);
    const dir = path.dirname(studentGwsCredentialsPath('user_dirmode'));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// ─── hasStudentCredentials ────────────────────────────────────────────────────

describe('hasStudentCredentials', () => {
  it('returns false before any write', () => {
    expect(hasStudentCredentials('user:nobody')).toBe(false);
  });

  it('returns true after write', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    expect(hasStudentCredentials('user:test01')).toBe(true);
  });

  it('returns false after clear', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    clearStudentCredentials('user:test01');
    expect(hasStudentCredentials('user:test01')).toBe(false);
  });
});

// ─── loadStudentCredentials ──────────────────────────────────────────────────

describe('loadStudentCredentials', () => {
  it('round-trips GwsCredentialsJson correctly', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    const loaded = loadStudentCredentials('user:test01');
    expect(loaded).not.toBeNull();
    expect(loaded!.client_id).toBe('client-id-123');
    expect(loaded!.client_secret).toBe('client-secret-456');
    expect(loaded!.refresh_token).toBe('refresh-token-789');
    expect(loaded!.access_token).toBe('access-token-abc');
    expect(loaded!.token_type).toBe('Bearer');
    expect(loaded!.expiry_date).toBe(9999999999000);
    expect(loaded!.scope).toBe('openid https://www.googleapis.com/auth/drive');
  });

  it('returns null when the file does not exist', () => {
    expect(loadStudentCredentials('user:ghost')).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    const credPath = path.join(tmpDir, 'student-google-auth', 'user_badjson', 'credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, '{not valid json}', { mode: 0o600 });
    expect(loadStudentCredentials('user:badjson')).toBeNull();
  });

  it('returns null when client_id is missing', () => {
    const { client_id: _omit, ...withoutClientId } = SAMPLE_CREDS;
    writeStudentCredentials('user:test01', withoutClientId as unknown as GwsCredentialsJson);
    expect(loadStudentCredentials('user:test01')).toBeNull();
  });

  it('returns null when client_secret is missing', () => {
    const { client_secret: _omit, ...withoutClientSecret } = SAMPLE_CREDS;
    writeStudentCredentials('user:test01', withoutClientSecret as unknown as GwsCredentialsJson);
    expect(loadStudentCredentials('user:test01')).toBeNull();
  });

  it('returns null when refresh_token is missing', () => {
    const { refresh_token: _omit, ...withoutRefreshToken } = SAMPLE_CREDS;
    writeStudentCredentials('user:test01', withoutRefreshToken as unknown as GwsCredentialsJson);
    expect(loadStudentCredentials('user:test01')).toBeNull();
  });
});

// ─── clearStudentCredentials ──────────────────────────────────────────────────

describe('clearStudentCredentials', () => {
  it('removes the credentials file', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    expect(hasStudentCredentials('user:test01')).toBe(true);
    clearStudentCredentials('user:test01');
    expect(hasStudentCredentials('user:test01')).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    // Must not throw
    expect(() => clearStudentCredentials('user:ghost')).not.toThrow();
  });

  it('is idempotent — second clear after first is also a no-op', () => {
    writeStudentCredentials('user:test01', SAMPLE_CREDS);
    clearStudentCredentials('user:test01');
    expect(() => clearStudentCredentials('user:test01')).not.toThrow();
    expect(hasStudentCredentials('user:test01')).toBe(false);
  });
});

// ─── userId sanitization ──────────────────────────────────────────────────────

describe('userId with special characters', () => {
  it('sanitizes class:student_03 to class_student_03 in the path', () => {
    writeStudentCredentials('class:student_03', SAMPLE_CREDS);

    // Verify the directory uses the sanitized name (colon → underscore)
    const expectedDir = path.join(tmpDir, 'student-google-auth', 'class_student_03');
    expect(fs.existsSync(expectedDir)).toBe(true);

    // And that the round-trip works
    expect(hasStudentCredentials('class:student_03')).toBe(true);
    const loaded = loadStudentCredentials('class:student_03');
    expect(loaded).not.toBeNull();
    expect(loaded!.refresh_token).toBe('refresh-token-789');
  });

  it('colliding sanitized names share a path — last write wins', () => {
    writeStudentCredentials('class:student_03', { ...SAMPLE_CREDS, refresh_token: 'colon-version' });
    writeStudentCredentials('class_student_03', { ...SAMPLE_CREDS, refresh_token: 'underscore-version' });

    // Both sanitize to the same directory name — last write wins
    const loaded = loadStudentCredentials('class:student_03');
    expect(loaded).not.toBeNull();
    // Both map to class_student_03 → same path → second write wins
    expect(loaded!.refresh_token).toBe('underscore-version');
  });
});
