/**
 * Backfill stale agent_groups.agent_provider values to 'pi'.
 *
 * After d-3 removes the host-side claude.ts and codex.ts harness adapters,
 * any agent group still carrying agent_provider='claude' or 'codex' will
 * fail to spawn — those provider IDs are no longer registered. This
 * migration rewrites them to 'pi', which is the sole registered harness.
 *
 * Idempotent: only touches rows where the value is exactly 'claude' or
 * 'codex'. Null values and already-'pi' rows are left unchanged.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'backfill-agent-provider-pi',
  up(db: Database.Database) {
    db.transaction(() => {
      db.prepare("UPDATE agent_groups SET agent_provider = 'pi' WHERE agent_provider IN ('claude', 'codex')").run();
    })();
  },
};
