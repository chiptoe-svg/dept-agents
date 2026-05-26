/**
 * Drop the classroom-only agent_groups.model column (added in 014-agent-model).
 * Model is now stored in container_configs.model, which is the canonical
 * source of truth since migration 017 added the container_configs table.
 *
 * Migration logic:
 *   1. For each agent_groups row with a non-null model, seed a FULL
 *      container_configs row from the on-disk container.json (if present),
 *      using agent_groups.model as the authoritative model value.
 *      INSERT OR IGNORE means we never overwrite a hand-edited DB row;
 *      a follow-up UPDATE fills `model` if that pre-existing row had it NULL.
 *   2. DROP COLUMN model from agent_groups.
 *
 * Reading container.json from inside the migration is unusual but necessary:
 * backfillContainerConfigs() runs *after* migrations, and its idempotency
 * check (`if row exists, skip`) would otherwise skip the partial rows this
 * migration creates and silently lose the on-disk mcpServers/packages/skills
 * for every classroom group at upgrade time.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { GROUPS_DIR } from '../../config.js';
import type { Migration } from './index.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, unknown>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: unknown[];
  skills?: string[] | 'all';
  provider?: string;
  effort?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
  env?: Record<string, string>;
  allowedModels?: { provider: string; model: string }[];
}

export const migration020: Migration = {
  version: 20,
  name: 'drop-agent-groups-model',
  up(db: Database.Database) {
    db.transaction(() => {
      const groups = db.prepare('SELECT id, folder, model FROM agent_groups WHERE model IS NOT NULL').all() as {
        id: string;
        folder: string;
        model: string;
      }[];

      const now = new Date().toISOString();

      const insertFull = db.prepare(`
        INSERT OR IGNORE INTO container_configs (
          agent_group_id, provider, model, effort, image_tag, assistant_name,
          max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
          additional_mounts, cli_scope, env, allowed_models, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const updateModelIfNull = db.prepare(
        'UPDATE container_configs SET model = ?, updated_at = ? WHERE agent_group_id = ? AND model IS NULL',
      );

      for (const g of groups) {
        let legacy: LegacyContainerJson = {};
        const filePath = path.join(GROUPS_DIR, g.folder, 'container.json');
        if (fs.existsSync(filePath)) {
          try {
            legacy = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyContainerJson;
          } catch {
            // Corrupt JSON — fall through with defaults. The model is still
            // preserved from agent_groups.model.
          }
        }

        insertFull.run(
          g.id,
          legacy.provider ?? null,
          g.model, // agent_groups.model is authoritative at migration time
          legacy.effort ?? null,
          legacy.imageTag ?? null,
          legacy.assistantName ?? null,
          legacy.maxMessagesPerPrompt ?? null,
          JSON.stringify(legacy.skills ?? 'all'),
          JSON.stringify(legacy.mcpServers ?? {}),
          JSON.stringify(legacy.packages?.apt ?? []),
          JSON.stringify(legacy.packages?.npm ?? []),
          JSON.stringify(legacy.additionalMounts ?? []),
          'group',
          JSON.stringify(legacy.env ?? {}),
          JSON.stringify(legacy.allowedModels ?? []),
          now,
        );

        // If a row already existed (insert no-op'd) with a null model, copy it over.
        updateModelIfNull.run(g.model, now, g.id);
      }

      db.prepare('ALTER TABLE agent_groups DROP COLUMN model').run();
    })();
  },
};
