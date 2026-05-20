/**
 * Classroom roster — email → user_id mapping.
 *
 * Phase 2 of plans/classroom-web-multiuser.md. Populated either by
 * /add-classroom's --roster <csv> flag (deferred follow-up against the
 * classroom branch) or by `ncl` inserts in the meantime. Consumed by
 * the Google OAuth callback in src/channels/playground/google-oauth.ts:
 * the email Google asserts is normalized to lowercase, looked up here,
 * and on hit produces the canonical user_id (e.g. `class:student_03`)
 * to bind to the new playground session.
 */
import { getDb } from './connection.js';

export interface ClassroomRosterEntry {
  email: string; // normalized lowercase
  user_id: string; // e.g. 'class:student_03'
  agent_group_id: string | null;
  added_at: number; // ms since epoch
  // Set by markEnrolled() on the student's first successful sign-in via
  // /login/enroll. Null until that happens. Optional because most query
  // helpers SELECT only the four base columns; only lookupRosterByUserId
  // pulls the enrollment columns. Used by the Roster card to show
  // ✅ vs ⚪ for "has signed in yet?".
  enrolled_at?: string | null;
  enrollment_session_id?: string | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function lookupRosterByEmail(email: string): ClassroomRosterEntry | null {
  const row = getDb()
    .prepare('SELECT email, user_id, agent_group_id, added_at FROM classroom_roster WHERE email = ?')
    .get(normalizeEmail(email)) as ClassroomRosterEntry | undefined;
  return row ?? null;
}

export function listRoster(): ClassroomRosterEntry[] {
  return getDb()
    .prepare('SELECT email, user_id, agent_group_id, added_at FROM classroom_roster ORDER BY email')
    .all() as ClassroomRosterEntry[];
}

/**
 * UPSERT — re-running /add-classroom with the same roster CSV is
 * idempotent on email. Replacing user_id is allowed (a roster reset can
 * remap a student to a different agent_group); added_at always reflects
 * the most-recent add.
 */
export function upsertRosterEntry(entry: { email: string; user_id: string; agent_group_id?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO classroom_roster (email, user_id, agent_group_id, added_at)
       VALUES (@email, @user_id, @agent_group_id, @added_at)
       ON CONFLICT(email) DO UPDATE SET
         user_id        = excluded.user_id,
         agent_group_id = excluded.agent_group_id,
         added_at       = excluded.added_at`,
    )
    .run({
      email: normalizeEmail(entry.email),
      user_id: entry.user_id,
      agent_group_id: entry.agent_group_id ?? null,
      added_at: Date.now(),
    });
}

export function removeRosterEntry(email: string): boolean {
  const info = getDb().prepare('DELETE FROM classroom_roster WHERE email = ?').run(normalizeEmail(email));
  return info.changes > 0;
}

/**
 * Look up a roster entry by its canonical user_id (e.g. `class:student_03`).
 * Returns null when no row has that user_id. Companion to `lookupRosterByEmail`
 * for cases where we know the userId (e.g. inside an authenticated session)
 * and need the email or agent_group_id.
 */
export function lookupRosterByUserId(userId: string): ClassroomRosterEntry | null {
  const row = getDb()
    .prepare(
      'SELECT email, user_id, agent_group_id, added_at, enrolled_at, enrollment_session_id FROM classroom_roster WHERE user_id = ?',
    )
    .get(userId) as ClassroomRosterEntry | undefined;
  return row ?? null;
}

/**
 * Look up a roster entry by its bound agent_group_id. Used by the
 * classroom provider resolver to map a container's agentGroupId back
 * to the student's canonical user_id. Returns null when no row binds
 * this agent_group_id (solo-install path — caller treats as "not in
 * classroom" and falls through to host .env creds).
 */
export function lookupRosterByAgentGroupId(agentGroupId: string): ClassroomRosterEntry | null {
  const row = getDb()
    .prepare('SELECT email, user_id, agent_group_id, added_at FROM classroom_roster WHERE agent_group_id = ? LIMIT 1')
    .get(agentGroupId) as ClassroomRosterEntry | undefined;
  return row ?? null;
}

// ── class-enrollment-passcode:roster-helpers START ────────────────────────

/**
 * Mark a roster row as enrolled. Sets enrolled_at to the current ISO
 * timestamp and records the session cookie value. Only updates if the
 * row exists and enrolled_at is currently NULL (first-come-first-served).
 * Returns true if the row was updated (i.e., this caller won the race),
 * false if already claimed or email not found.
 */
export function markEnrolled(email: string, sessionId: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE classroom_roster
          SET enrolled_at = ?, enrollment_session_id = ?
        WHERE email = ? AND enrolled_at IS NULL`,
    )
    .run(new Date().toISOString(), sessionId, normalizeEmail(email));
  return info.changes > 0;
}

/**
 * Reset a student's enrollment so they can re-enroll (e.g., instructor
 * intervention when the original claim was by the wrong device). Clears
 * both enrolled_at and enrollment_session_id. Returns true if a row
 * was found and updated.
 */
export function resetEnrollment(email: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE classroom_roster
          SET enrolled_at = NULL, enrollment_session_id = NULL
        WHERE email = ?`,
    )
    .run(normalizeEmail(email));
  return info.changes > 0;
}

/** Returns true if the roster row for this email has been claimed. */
export function isEnrolled(email: string): boolean {
  const row = getDb().prepare('SELECT enrolled_at FROM classroom_roster WHERE email = ?').get(normalizeEmail(email)) as
    | { enrolled_at: string | null }
    | undefined;
  if (!row) return false;
  return row.enrolled_at !== null;
}

// ── class-enrollment-passcode:roster-helpers END ──────────────────────────
