/**
 * Drop the classroom-only agent_groups.model column (added in 014-agent-model).
 * Model is now stored in container_configs.model, which is the canonical
 * source of truth since migration 017 added the container_configs table.
 *
 * Migration logic:
 *   1. For each agent_groups row with a non-null model, ensure a
 *      container_configs row exists, then copy the model value over — but
 *      only if container_configs.model is still NULL (don't overwrite an
 *      already-migrated value).
 *   2. DROP COLUMN model from agent_groups.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'drop-agent-groups-model',
  up(db: Database.Database) {
    db.transaction(() => {
      // Fetch every agent group that has a model set.
      const rows = db
        .prepare('SELECT id, model FROM agent_groups WHERE model IS NOT NULL')
        .all() as { id: string; model: string }[];

      const now = new Date().toISOString();

      for (const row of rows) {
        // Ensure a container_configs row exists for this group.
        db.prepare(
          'INSERT OR IGNORE INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)',
        ).run(row.id, now);

        // Copy the model only if container_configs.model is still NULL,
        // so we don't overwrite a value that was already set independently.
        db.prepare(
          'UPDATE container_configs SET model = ?, updated_at = ? WHERE agent_group_id = ? AND model IS NULL',
        ).run(row.model, now, row.id);
      }

      // Drop the column — better-sqlite3 supports DROP COLUMN on modern SQLite.
      db.prepare('ALTER TABLE agent_groups DROP COLUMN model').run();
    })();
  },
};
