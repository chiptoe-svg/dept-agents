/**
 * app_config — generic key/value store for department-wide settings.
 *
 * Seeds the four dept model defaults consumed by src/db/app-config.ts:
 * default_cloud_model/provider and private_model/provider. Values are
 * plain strings; callers own their own parsing.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'app-config',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    const seed = db.prepare('INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)');
    seed.run('default_cloud_model', 'qwen3.6-35b-a3b-fp8', now);
    seed.run('default_cloud_provider', 'clemson', now);
    seed.run('private_model', 'Qwen3.6-35B-A3B-UD-MLX-4bit', now);
    seed.run('private_provider', 'local', now);
  },
};
