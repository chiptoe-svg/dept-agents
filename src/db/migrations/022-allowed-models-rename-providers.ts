/**
 * Remap legacy provider names in container_configs.allowed_models.
 *
 * After the d-2 catalog rename, modelProvider values changed:
 *   'claude'  → 'anthropic'
 *   'codex'   → 'openai-codex'
 *
 * The playground UI filters allowed_models by modelProvider, so old rows
 * with provider: 'claude' or provider: 'codex' silently fail to match —
 * exposing every model to students who should see a restricted set.
 *
 * This migration reads every container_configs row with non-NULL
 * allowed_models, remaps the two legacy provider strings, and writes
 * the updated JSON back. Idempotent: rows that already use 'anthropic' /
 * 'openai-codex' (or any other value) are left untouched.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const REMAP: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai-codex',
};

export const migration022: Migration = {
  version: 22,
  name: 'allowed-models-rename-providers',
  up(db: Database.Database) {
    db.transaction(() => {
      const rows = db
        .prepare(
          "SELECT agent_group_id, allowed_models FROM container_configs WHERE allowed_models IS NOT NULL AND allowed_models != '' AND allowed_models != '[]'",
        )
        .all() as { agent_group_id: string; allowed_models: string }[];

      const update = db.prepare('UPDATE container_configs SET allowed_models = ? WHERE agent_group_id = ?');

      for (const row of rows) {
        let arr: { provider: string; model: string }[];
        try {
          arr = JSON.parse(row.allowed_models) as { provider: string; model: string }[];
        } catch {
          continue;
        }
        if (!Array.isArray(arr)) continue;

        // Check if any entry needs remapping.
        const needsRemap = arr.some((e) => e && typeof e.provider === 'string' && REMAP[e.provider] !== undefined);
        if (!needsRemap) continue;

        const remapped = arr.map((e) => {
          if (e && typeof e.provider === 'string' && REMAP[e.provider] !== undefined) {
            return { ...e, provider: REMAP[e.provider] };
          }
          return e;
        });
        update.run(JSON.stringify(remapped), row.agent_group_id);
      }
    })();
  },
};
