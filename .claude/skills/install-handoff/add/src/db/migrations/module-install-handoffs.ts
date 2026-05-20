import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Install handoff tokens — time-limited, single-use (or N-use) URLs that bundle
 * install state (.env, OAuth creds, optional groups/) for cloning a NanoClaw
 * install onto a new machine.
 *
 * Security model: the raw token (128-bit random) is NEVER stored. Only its
 * SHA-256 hash is persisted (token_hash). O(1) lookup without per-row salt
 * is safe here because the token is unguessable (128 bits); SHA-256 protects
 * the DB-leak scenario only, not brute force.
 *
 * The public `id` (64-bit hex) is returned at issue time and stored. It is
 * safe to log/print and is used for operator operations (revoke, list).
 *
 * Lives on the `install-handoff` branch. Installed by `/install-handoff`.
 */
export const moduleInstallHandoffs: Migration = {
  version: 19,
  name: 'install-handoffs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS install_handoffs (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        max_uses      INTEGER NOT NULL,
        current_uses  INTEGER NOT NULL DEFAULT 0,
        files_json    TEXT NOT NULL,
        revoked_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS install_handoffs_token_hash_idx ON install_handoffs(token_hash);
      CREATE INDEX IF NOT EXISTS install_handoffs_expires_at_idx ON install_handoffs(expires_at);
    `);
  },
};
