/**
 * Phase 2 of plans/classroom-web-multiuser.md — roster table.
 *
 * Maps a student's authenticated email (from Google OAuth) to the
 * canonical user_id (e.g. `class:student_03`) the existing classroom
 * role plumbing already produces. The mapping is what lets
 * /oauth/google/callback look up "is this email enrolled?" and, if so,
 * mint a session bound to the matching user_id.
 *
 * Email is the primary key — normalized to lowercase before insert and
 * lookup. agent_group_id is nullable for the case where a roster row
 * is provisioned ahead of the per-student group existing.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'classroom-roster',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classroom_roster (
        email          TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        agent_group_id TEXT,
        added_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_classroom_roster_user_id
        ON classroom_roster(user_id);
    `);
  },
};
