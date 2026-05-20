import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Class enrollment passcode — single-row table holding the current
 * scrypt-hashed 4-digit passcode shown in the instructor's Home card.
 * Students enter email + this passcode to claim their roster seat (first
 * come, first served). Old row is deleted on rotate so the table never
 * has more than one row.
 *
 * Also extends classroom_roster with two nullable columns for enrollment
 * tracking: enrolled_at (ISO string, set on first successful claim) and
 * enrollment_session_id (the playground session cookie value at claim
 * time, for audit/reset purposes).
 *
 * Lives on `main`. Registered into the migration array by this file's
 * import in src/db/migrations/index.ts.
 */
export const moduleClassEnrollmentPasscode: Migration = {
  version: 22,
  name: 'class-enrollment-passcode',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE class_enrollment_passcodes (
        id              INTEGER PRIMARY KEY,
        passcode_hash   TEXT NOT NULL,
        passcode_salt   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        rotated_by_user_id TEXT
      );

      ALTER TABLE classroom_roster ADD COLUMN enrolled_at TEXT;
      ALTER TABLE classroom_roster ADD COLUMN enrollment_session_id TEXT;
    `);
  },
};
