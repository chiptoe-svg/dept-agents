import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Class login tokens — long-lived, per-roster-user URL tokens that let
 * students log into the playground without going through Google OAuth.
 *
 * Each row is one token. Multiple non-revoked rows for the same user
 * are allowed (the redeemer accepts any active one); the rotation CLI
 * issues a fresh row and revokes earlier ones in the same transaction.
 *
 * Lookup happens by `token` (PRIMARY KEY) at every login. The
 * `(user_id, revoked_at)` partial-ish lookup is for the CLI's
 * list/rotate commands.
 *
 * Lives on the `classroom` branch and gets registered into the trunk
 * migration array by `/add-classroom` at install time.
 */
export const moduleClassLoginTokens: Migration = {
  version: 17,
  name: 'class-login-tokens',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE class_login_tokens (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
      CREATE INDEX idx_class_login_tokens_user ON class_login_tokens(user_id, revoked_at);
    `);
  },
};
