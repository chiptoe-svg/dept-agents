import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Pair codes for linking a student's playground (web) session to their
 * Telegram account. Issued on demand from /api/me/telegram/pair-code;
 * consumed when the bot receives `/pair-class CODE` in a DM. After
 * consumption, the student's Telegram DM messaging group is wired to
 * their student agent so DMs from their phone reach the same agent.
 */
export const moduleClassTelegramPair: Migration = {
  version: 0,
  name: 'class-telegram-pair-codes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS class_telegram_pair_codes (
        code             TEXT PRIMARY KEY,
        web_user_id      TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        consumed_at      INTEGER,
        telegram_user_id TEXT,
        telegram_handle  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_class_telegram_pair_codes_user
        ON class_telegram_pair_codes(web_user_id);
    `);
  },
};
