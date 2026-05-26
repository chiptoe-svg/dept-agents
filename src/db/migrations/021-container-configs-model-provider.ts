/**
 * Add model_provider TEXT column to container_configs.
 *
 * model_provider is the pi-provider model-provider knob (e.g. "anthropic",
 * "openai"). Distinct from `model` (which is the model name/ID) and from
 * `provider` (which is the agent harness, e.g. "pi", "claude").
 *
 * Backfill: for any existing row whose `env` JSON contains the key
 * NANOCLAW_PI_MODEL_PROVIDER, copy that value into the new column. This
 * preserves the setting for installs that set it via env before this column
 * existed.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'container-configs-model-provider',
  up(db: Database.Database) {
    db.transaction(() => {
      // Guard: skip if the column already exists (re-run safety).
      const cols = db.prepare("PRAGMA table_info(container_configs)").all() as { name: string }[];
      if (cols.some((c) => c.name === 'model_provider')) return;

      db.prepare('ALTER TABLE container_configs ADD COLUMN model_provider TEXT').run();

      // Backfill from env JSON where the key is present.
      const rows = db
        .prepare("SELECT agent_group_id, env FROM container_configs WHERE env IS NOT NULL AND env != '' AND env != '{}'")
        .all() as { agent_group_id: string; env: string }[];

      const update = db.prepare(
        'UPDATE container_configs SET model_provider = ? WHERE agent_group_id = ?',
      );

      for (const row of rows) {
        let envObj: Record<string, string> = {};
        try {
          envObj = JSON.parse(row.env) as Record<string, string>;
        } catch {
          continue;
        }
        const val = envObj['NANOCLAW_PI_MODEL_PROVIDER'];
        if (val !== undefined && val !== null && val !== '') {
          update.run(val, row.agent_group_id);
        }
      }
    })();
  },
};
