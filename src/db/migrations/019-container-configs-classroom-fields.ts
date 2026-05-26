import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Classroom-only addition to upstream's container_configs table.
 *
 * Classroom needs two extra fields the upstream schema doesn't have:
 *   - env: per-group env vars (GOOGLE_APPLICATION_CREDENTIALS etc.)
 *   - allowed_models: per-group model allowlist (driven by playground Models tab)
 *
 * Both stored as JSON-encoded text for symmetry with the other JSON columns
 * (mcp_servers, packages_apt, packages_npm, additional_mounts).
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-configs-classroom-fields',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN allowed_models TEXT NOT NULL DEFAULT '[]'").run();
  },
};
