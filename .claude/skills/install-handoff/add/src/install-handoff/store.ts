/**
 * Install handoff token store.
 *
 * Issues time-limited, N-use tokens for the install-handoff skill. The raw
 * token (128-bit random hex) is returned ONLY at issue time and embedded in
 * the URL. What is stored at rest is the SHA-256 hash of the token — no
 * plaintext, no salt (the token is unguessable, so brute-force protection
 * via KDF is unnecessary; SHA-256 covers the DB-leak scenario).
 *
 * Public-facing `id` (64-bit hex) is safe to log and is used for operator
 * operations (revoke, list). It is distinct from the token.
 *
 * consumeHandoff increments current_uses. When current_uses reaches max_uses
 * on a consume call, revoked_at is set immediately (so subsequent calls fail
 * fast without needing to compare against max_uses again).
 *
 * sweepExpiredHandoffs removes rows that are expired OR revoked-more-than-1h-ago.
 * The 1h grace window preserves recently-exhausted rows for log correlation.
 */
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IssueOpts {
  /** Milliseconds until expiry. */
  ttlMs: number;
  /** Number of times the bundle may be consumed. Typically 1; max 10. */
  maxUses: number;
  /** Bundle file manifest (name + byte size for each file). */
  files: { name: string; size: number }[];
}

export interface IssueResult {
  /** Public ID safe for logs and operator commands. */
  id: string;
  /** Raw token — embed in URL. NOT stored. Only returned at issue time. */
  token: string;
  /** ISO timestamp of expiry. */
  expiresAt: string;
}

export type GetResult =
  | {
      ok: true;
      id: string;
      files: { name: string; size: number }[];
      current_uses: number;
      max_uses: number;
      expires_at: string;
    }
  | { ok: false; reason: 'unknown-token' | 'expired' | 'revoked' | 'exhausted' };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

interface HandoffRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  current_uses: number;
  files_json: string;
  revoked_at: string | null;
}

/**
 * Resolve a raw token to its DB row, returning a typed failure reason
 * if the row is missing, expired, revoked, or exhausted.
 */
type FailResult = Extract<GetResult, { ok: false }>;

function resolveToken(token: string): { row: HandoffRow } | FailResult {
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM install_handoffs WHERE token_hash = ?').get(hash) as
    | HandoffRow
    | undefined;
  if (!row) return { ok: false, reason: 'unknown-token' as const };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' as const };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' as const };
  if (row.current_uses >= row.max_uses) return { ok: false, reason: 'exhausted' as const };
  return { row };
}

function rowToOkResult(row: HandoffRow): Extract<GetResult, { ok: true }> {
  return {
    ok: true,
    id: row.id,
    files: JSON.parse(row.files_json) as { name: string; size: number }[],
    current_uses: row.current_uses,
    max_uses: row.max_uses,
    expires_at: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Mint a new handoff token. The raw token is returned here and ONLY here —
 * the caller must embed it in the URL and not store it anywhere.
 */
export function issueHandoff(opts: IssueOpts): IssueResult {
  const token = crypto.randomBytes(16).toString('hex'); // 32-char hex, 128 bits
  return _issueWithToken({ ...opts, token });
}

/**
 * Internal: issue using a caller-provided token. The CLI uses this so it can
 * bundle files into `data/handoffs/<token>/` first (needs the token) and then
 * register the handoff with the resulting file manifest under the same token.
 *
 * Underscore prefix marks "skill-internal API" — not for general use; bypasses
 * the "store generates the token" invariant.
 */
export function _issueWithToken(opts: IssueOpts & { token: string }): IssueResult {
  const db = getDb();
  const token = opts.token;
  const id = crypto.randomBytes(8).toString('hex'); // 16-char hex, 64 bits
  const tokenHash = hashToken(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + opts.ttlMs).toISOString();
  const filesJson = JSON.stringify(opts.files);

  db.prepare(
    `INSERT INTO install_handoffs
       (id, token_hash, created_at, expires_at, max_uses, current_uses, files_json, revoked_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
  ).run(id, tokenHash, createdAt, expiresAt, opts.maxUses, filesJson);

  log.info('install-handoff: token issued', {
    id,
    expiresAt,
    maxUses: opts.maxUses,
    files: opts.files.length,
  });
  return { id, token, expiresAt };
}

/**
 * Validate a token without consuming a use. Returns the handoff metadata on
 * success, or a typed failure reason if the token is unknown/expired/revoked/
 * exhausted.
 */
export function getHandoff(token: string): GetResult {
  const resolved = resolveToken(token);
  if ('ok' in resolved) return resolved;
  return rowToOkResult(resolved.row);
}

/**
 * Validate and consume one use of a handoff. On the use that reaches max_uses,
 * revoked_at is set so subsequent calls fail immediately.
 *
 * Returns the same GetResult shape as getHandoff. Callers should check ok
 * before serving files.
 *
 * Atomicity: the resolveToken→UPDATE pair is NOT wrapped in a transaction.
 * Safe under the install-handoff threat model — single host process, all SQLite
 * calls are synchronous via better-sqlite3, and Node's event loop serializes
 * them. Add a transaction if this ever moves to a multi-process or async-DB
 * setting.
 */
export function consumeHandoff(token: string): GetResult {
  const db = getDb();
  const resolved = resolveToken(token);
  if ('ok' in resolved) return resolved;
  const { row } = resolved;

  const newUses = row.current_uses + 1;
  const isNowExhausted = newUses >= row.max_uses;

  db.prepare(
    `UPDATE install_handoffs
        SET current_uses = ?,
            revoked_at   = CASE WHEN ? THEN ? ELSE NULL END
      WHERE id = ?`,
  ).run(newUses, isNowExhausted ? 1 : 0, isNowExhausted ? nowIso() : null, row.id);

  log.info('install-handoff: token consumed', {
    id: row.id,
    currentUses: newUses,
    maxUses: row.max_uses,
    exhausted: isNowExhausted,
  });

  // Return the updated state.
  return {
    ok: true,
    id: row.id,
    files: JSON.parse(row.files_json) as { name: string; size: number }[],
    current_uses: newUses,
    max_uses: row.max_uses,
    expires_at: row.expires_at,
  };
}

/**
 * Immediately revoke a handoff by its public id. Returns true if a row was
 * updated; false if no such id exists (or already revoked — idempotent).
 */
export function revokeHandoff(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare(`UPDATE install_handoffs SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowIso(), id);
  if (result.changes > 0) log.info('install-handoff: token revoked', { id });
  return result.changes > 0;
}

/** Status categories for operator display. */
type HandoffStatus = 'active' | 'expired' | 'exhausted' | 'revoked';

/**
 * List all handoffs in reverse-chronological order. Derives a human-readable
 * status from the row state.
 */
export function listHandoffs(): {
  id: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  current_uses: number;
  files_count: number;
  revoked_at: string | null;
  status: HandoffStatus;
}[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM install_handoffs ORDER BY created_at DESC')
    .all() as HandoffRow[];

  const now = Date.now();
  return rows.map((row) => {
    let status: HandoffStatus;
    if (row.revoked_at !== null) {
      // Distinguish manually-revoked vs auto-revoked-on-exhaustion.
      // Both show as 'revoked' if revoked_at is set; exhaustion check
      // is secondary (exhausted rows also get revoked_at set).
      status = row.current_uses >= row.max_uses ? 'exhausted' : 'revoked';
    } else if (new Date(row.expires_at).getTime() < now) {
      status = 'expired';
    } else {
      status = 'active';
    }
    const files = JSON.parse(row.files_json) as { name: string; size: number }[];
    return {
      id: row.id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      max_uses: row.max_uses,
      current_uses: row.current_uses,
      files_count: files.length,
      revoked_at: row.revoked_at,
      status,
    };
  });
}

/**
 * Delete rows that are expired OR revoked more than 1h ago. The 1h grace
 * window keeps recently-exhausted rows available for log correlation.
 * Returns the number of rows deleted.
 */
export function sweepExpiredHandoffs(): number {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = nowIso();
  const result = db
    .prepare(
      `DELETE FROM install_handoffs
          WHERE expires_at < ?
             OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    )
    .run(now, oneHourAgo);
  // Also clean up orphaned filesystem dirs whose DB row is gone (either via
  // the DELETE above, or via prior failed-mid-bundle attempts). Each dir is
  // named by the raw token; hash and check if a row still exists.
  const orphans = sweepOrphanBundleDirs();
  if (result.changes > 0 || orphans > 0) {
    log.info('install-handoff: sweep', { rowsDeleted: result.changes, orphanDirsDeleted: orphans });
  }
  return result.changes + orphans;
}

/**
 * Scan data/handoffs/ for dirs whose DB row no longer exists and remove them.
 * Returns the number of dirs deleted.
 */
function sweepOrphanBundleDirs(): number {
  const handoffsRoot = path.join(DATA_DIR, 'handoffs');
  if (!fs.existsSync(handoffsRoot)) return 0;

  const db = getDb();
  let deleted = 0;
  for (const name of fs.readdirSync(handoffsRoot)) {
    // Token-named dirs are 32-char hex. Skip anything else.
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const tokenHash = hashToken(name);
    const row = db.prepare('SELECT 1 FROM install_handoffs WHERE token_hash = ?').get(tokenHash);
    if (!row) {
      fs.rmSync(path.join(handoffsRoot, name), { recursive: true, force: true });
      deleted++;
    }
  }
  return deleted;
}
