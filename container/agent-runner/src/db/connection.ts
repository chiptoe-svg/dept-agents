/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

// Defaults match the container's mount layout; the SESSION_* env-var
// overrides exist for off-container callers (e.g., the host-side
// pi-mcp-bridge test that spawns the MCP server pointed at a tmpdir).
const DEFAULT_INBOUND_PATH = process.env.SESSION_INBOUND_DB_PATH ?? '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = process.env.SESSION_OUTBOUND_DB_PATH ?? '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = process.env.SESSION_HEARTBEAT_PATH ?? '/workspace/.heartbeat';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _testMode = false;

/**
 * SQLite raises "attempt to write a readonly database" when it cannot create
 * its rollback journal next to the DB file (journal_mode=DELETE writes
 * `outbound.db-journal` in the same dir on every write transaction). On the
 * Apple Container / virtiofs bind mount that holds /workspace, the dir is
 * occasionally not write-ready for a brief moment right after a container
 * (re)spawn — the file isn't actually read-only, the mount just hasn't
 * settled. Without a retry the agent-runner treats this as fatal and the
 * whole turn is lost; the host then respawns and usually succeeds, which is
 * the "really slow / sometimes no answer" failure mode. Retry briefly so a
 * transient window is invisible.
 */
function isReadonlyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /readonly database|SQLITE_READONLY/i.test(msg);
}

const READONLY_RETRY_ATTEMPTS = 20;
const READONLY_RETRY_DELAY_MS = 150; // ~3s max before giving up

/**
 * Run an outbound-DB write, retrying on the transient readonly error above.
 * Pass a thunk that re-fetches `getOutboundDb()` internally (don't capture the
 * handle outside) — on each retry the cached connection is dropped so the
 * next getOutboundDb() reopens against the settled mount.
 */
export function withReadonlyRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < READONLY_RETRY_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isReadonlyError(err)) throw err;
      lastErr = err;
      try {
        _outbound?.close();
      } catch {
        /* ignore — reopening anyway */
      }
      _outbound = null;
      if (attempt < READONLY_RETRY_ATTEMPTS - 1) Bun.sleepSync(READONLY_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/**
 * Run an inbound-DB read, retrying on the same transient readonly error
 * `withReadonlyRetry` guards for outbound writes (most commonly seen here as
 * `SQLITE_READONLY_ROLLBACK`): the host's DELETE-journal commits leave a hot
 * rollback journal file next to `inbound.db` for a brief moment, and
 * virtiofs does not propagate SQLite's advisory locks from host to guest, so
 * a read-only opener can occasionally see that hot journal and refuse to
 * proceed (it can't roll the journal back itself). Without a retry this
 * surfaces as noisy, non-fatal poll-loop errors that mask any real failure
 * underneath.
 *
 * Unlike `withReadonlyRetry`, this does not touch the cached `_outbound`
 * singleton — `openInboundDb()` opens a fresh connection on every call (no
 * cached handle to invalidate outside test mode), so the thunk passed here
 * should call `openInboundDb()` itself; simply re-running it on retry is
 * enough to pick up the settled mount.
 */
export function withInboundReadonlyRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < READONLY_RETRY_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isReadonlyError(err)) throw err;
      lastErr = err;
      if (attempt < READONLY_RETRY_ATTEMPTS - 1) Bun.sleepSync(READONLY_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), close: () => {} } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (_outbound) return _outbound;
  // Opening + the PRAGMA/CREATE-TABLE init all WRITE (they need the journal),
  // so the open itself can hit the transient readonly window after a respawn.
  // Retry until the mount is write-ready instead of crashing the runner.
  withReadonlyRetry(() => {
    const db = new Database(DEFAULT_OUTBOUND_PATH);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      // Lightweight forward-compat: session_state was added after the initial
      // v2 schema, so older session DBs don't have it. Create it on demand
      // instead of requiring a formal migration pass. Also handle the case
      // where an earlier revision of this table existed without updated_at —
      // ALTER TABLE to add any missing columns.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_state (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const cols = new Set(
        (db.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (!cols.has('updated_at')) {
        db.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
      }
      // container_state: tracks the current tool in flight (if any) so the host
      // sweep can widen its stuck tolerance when Bash is running with a user-
      // declared long timeout. Forward-compat for older outbound.db files.
      db.exec(`
        CREATE TABLE IF NOT EXISTS container_state (
          id                       INTEGER PRIMARY KEY CHECK (id = 1),
          current_tool             TEXT,
          tool_declared_timeout_ms INTEGER,
          tool_started_at          TEXT,
          updated_at               TEXT NOT NULL
        );
      `);
    } catch (err) {
      // Don't leak a half-open handle between retries.
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    _outbound = db;
  });
  return _outbound!;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  withReadonlyRetry(() =>
    getOutboundDb()
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
      )
      .run(tool, declaredTimeoutMs, now, now),
  );
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  withReadonlyRetry(() =>
    getOutboundDb()
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
      )
      .run(now),
  );
}

/**
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  withReadonlyRetry(() => getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run());
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      series_id      TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      tokens_in      INTEGER,
      tokens_out     INTEGER,
      latency_ms     INTEGER,
      provider       TEXT,
      model          TEXT
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
  `);

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}

/**
 * @deprecated Use getInboundDb() / getOutboundDb() instead.
 * Kept for backward compatibility during migration.
 */
export function getSessionDb(): Database {
  return getInboundDb();
}
