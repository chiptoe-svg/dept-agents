/**
 * backstop_usage — tracks the most recent time each agent group's LLM
 * requests fell back to the department .env credential (the "backstop")
 * instead of a per-user connected account.
 *
 * Recorded from src/backstop-usage.ts via the recordBackstop hook in
 * src/user-provider-resolver.ts. One row per agent_group_id (upserted on
 * every fresh backstop use, debounced in application code so this table
 * isn't hammered on every proxied request). A memberless/system agent
 * group simply never gets a row — there is no FK to agent_groups here,
 * since the recorder must tolerate any agent_group_id string without
 * assuming the group exists in any other table.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration024: Migration = {
  version: 24,
  name: 'backstop-usage',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS backstop_usage (
        agent_group_id TEXT PRIMARY KEY,
        provider_id    TEXT NOT NULL,
        at             TEXT NOT NULL
      );
    `);
  },
};
