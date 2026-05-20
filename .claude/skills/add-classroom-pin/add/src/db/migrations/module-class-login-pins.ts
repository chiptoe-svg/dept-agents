import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Class login PINs — short-lived 6-digit codes emailed to a student to
 * verify they actually own the email associated with a class-token URL.
 * Closes the URL-forwarding gap (a student forwarding their bookmark
 * URL = the friend can be them; PIN delivered to school email blocks
 * that since the friend doesn't have access to the inbox).
 *
 * Each row is one in-flight redemption attempt. Rows are short-lived
 * (10-min TTL) and single-use; sweep-expired drops them. Lives on the
 * `classroom` branch and gets registered into the trunk migration array
 * by `/add-classroom-pin` at install time.
 */
export const moduleClassLoginPins: Migration = {
  version: 18,
  name: 'class-login-pins',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE class_login_pins (
        id          TEXT PRIMARY KEY,
        token       TEXT NOT NULL,
        email       TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        pin_hash    TEXT NOT NULL,
        pin_salt    TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        used_at     TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_class_login_pins_expires ON class_login_pins(expires_at);
    `);
  },
};
