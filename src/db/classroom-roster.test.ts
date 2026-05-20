import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  isEnrolled,
  listRoster,
  lookupRosterByEmail,
  lookupRosterByUserId,
  markEnrolled,
  removeRosterEntry,
  resetEnrollment,
  upsertRosterEntry,
} from './classroom-roster.js';

describe('classroom_roster', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  it('upserts new entries and looks them up by email', () => {
    upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03' });
    const entry = lookupRosterByEmail('alice@school.edu');
    expect(entry).not.toBeNull();
    expect(entry!.user_id).toBe('class:student_03');
    expect(entry!.agent_group_id).toBeNull();
  });

  it('normalizes email to lowercase on insert and lookup', () => {
    upsertRosterEntry({ email: 'Bob@School.Edu  ', user_id: 'class:student_04' });
    expect(lookupRosterByEmail('bob@school.edu')).not.toBeNull();
    expect(lookupRosterByEmail('BOB@SCHOOL.EDU')).not.toBeNull();
    const all = listRoster();
    expect(all.map((e) => e.email)).toContain('bob@school.edu');
  });

  it('upsert is idempotent on email and replaces user_id + agent_group_id', () => {
    upsertRosterEntry({ email: 'carol@school.edu', user_id: 'class:student_05', agent_group_id: 'agA' });
    upsertRosterEntry({ email: 'carol@school.edu', user_id: 'class:student_05_v2', agent_group_id: 'agB' });
    const entry = lookupRosterByEmail('carol@school.edu')!;
    expect(entry.user_id).toBe('class:student_05_v2');
    expect(entry.agent_group_id).toBe('agB');
    expect(listRoster().filter((e) => e.email === 'carol@school.edu')).toHaveLength(1);
  });

  it('lookup returns null for unknown email', () => {
    expect(lookupRosterByEmail('nobody@school.edu')).toBeNull();
  });

  it('remove drops the row and returns true; second remove returns false', () => {
    upsertRosterEntry({ email: 'dan@school.edu', user_id: 'class:student_06' });
    expect(removeRosterEntry('dan@school.edu')).toBe(true);
    expect(removeRosterEntry('dan@school.edu')).toBe(false);
    expect(lookupRosterByEmail('dan@school.edu')).toBeNull();
  });

  it('lookupRosterByUserId returns the entry for a known userId', () => {
    upsertRosterEntry({ email: 'eve@school.edu', user_id: 'class:student_07', agent_group_id: 'ag_eve' });
    const entry = lookupRosterByUserId('class:student_07');
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe('eve@school.edu');
    expect(entry!.agent_group_id).toBe('ag_eve');
  });

  it('lookupRosterByUserId returns null for an unknown userId', () => {
    expect(lookupRosterByUserId('class:nobody')).toBeNull();
  });

  // ── class-enrollment-passcode:roster-helper tests START ──────────────────

  it('isEnrolled returns false for a fresh (unenrolled) row', () => {
    upsertRosterEntry({ email: 'frank@school.edu', user_id: 'class:student_08' });
    expect(isEnrolled('frank@school.edu')).toBe(false);
  });

  it('isEnrolled returns false for unknown email', () => {
    expect(isEnrolled('nobody@school.edu')).toBe(false);
  });

  it('markEnrolled sets enrolled_at and returns true on first call', () => {
    upsertRosterEntry({ email: 'grace@school.edu', user_id: 'class:student_09' });
    const ok = markEnrolled('grace@school.edu', 'sess-abc');
    expect(ok).toBe(true);
    expect(isEnrolled('grace@school.edu')).toBe(true);
  });

  it('markEnrolled returns false on a second call (already claimed)', () => {
    upsertRosterEntry({ email: 'hank@school.edu', user_id: 'class:student_10' });
    markEnrolled('hank@school.edu', 'sess-first');
    const second = markEnrolled('hank@school.edu', 'sess-second');
    expect(second).toBe(false);
    // First session still in the DB.
    const row = getDb()
      .prepare('SELECT enrollment_session_id FROM classroom_roster WHERE email = ?')
      .get('hank@school.edu') as { enrollment_session_id: string } | undefined;
    expect(row?.enrollment_session_id).toBe('sess-first');
  });

  it('markEnrolled returns false for unknown email', () => {
    expect(markEnrolled('missing@school.edu', 'sess-x')).toBe(false);
  });

  it('resetEnrollment clears enrolled_at and returns true', () => {
    upsertRosterEntry({ email: 'iris@school.edu', user_id: 'class:student_11' });
    markEnrolled('iris@school.edu', 'sess-iris');
    expect(isEnrolled('iris@school.edu')).toBe(true);
    const ok = resetEnrollment('iris@school.edu');
    expect(ok).toBe(true);
    expect(isEnrolled('iris@school.edu')).toBe(false);
    // Can enroll again after reset.
    expect(markEnrolled('iris@school.edu', 'sess-iris-2')).toBe(true);
  });

  it('resetEnrollment returns false for unknown email', () => {
    expect(resetEnrollment('nobody@school.edu')).toBe(false);
  });

  // ── class-enrollment-passcode:roster-helper tests END ────────────────────
});
