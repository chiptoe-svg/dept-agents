/**
 * WAL-aware backup of data/v2.db using better-sqlite3's backup() API.
 * Captures both the main file and un-checkpointed WAL into a single
 * consistent snapshot, even while the host is actively writing.
 *
 * Usage: pnpm exec tsx scripts/backup-db.ts <destination-path>
 */
import Database from 'better-sqlite3';

const dest = process.argv[2];
if (!dest) {
  console.error('Usage: pnpm exec tsx scripts/backup-db.ts <destination-path>');
  process.exit(1);
}

const db = new Database('data/v2.db', { readonly: true });
await db.backup(dest);
db.close();
console.log(`Backed up to ${dest}`);
