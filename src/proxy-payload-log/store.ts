import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payloads (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  upstream_route  TEXT NOT NULL,
  upstream_path   TEXT NOT NULL,
  request_body    BLOB NOT NULL,
  request_bytes   INTEGER NOT NULL,
  truncated       INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  sections_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_payloads_ts ON payloads(ts);
`;

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const RETAIN_ROWS = 50;

export interface PayloadRow {
  seq: number;
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  requestBody: Buffer;
  requestBytes: number;
  truncated: boolean;
  responseStatus: number | null;
  sectionsJson: string | null;
}

export interface WriteInput {
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  body: Buffer;
}

export interface PayloadStore {
  write(input: WriteInput): number;
  patch(seq: number, fields: { responseStatus?: number; sectionsJson?: string }): void;
  list(opts: { limit: number; afterSeq: number }): PayloadRow[];
  close(): void;
}

export interface OpenOpts {
  baseDir: string;
  agentGroupId: string;
  sessionId: string;
}

export function openStore(opts: OpenOpts): PayloadStore {
  const dir = path.join(opts.baseDir, opts.agentGroupId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${opts.sessionId}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    'INSERT INTO payloads (ts, upstream_route, upstream_path, request_body, request_bytes, truncated) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const pruneStmt = db.prepare('DELETE FROM payloads WHERE seq <= (SELECT MAX(seq) - ? FROM payloads)');
  const listStmt = db.prepare(
    'SELECT seq, ts, upstream_route, upstream_path, request_body, request_bytes, truncated, response_status, sections_json FROM payloads WHERE seq > ? ORDER BY seq ASC LIMIT ?',
  );
  const patchStatus = db.prepare('UPDATE payloads SET response_status = ? WHERE seq = ?');
  const patchSections = db.prepare('UPDATE payloads SET sections_json = ? WHERE seq = ?');

  return {
    write(input) {
      const originalLen = input.body.length;
      const truncated = originalLen > MAX_BODY_BYTES ? 1 : 0;
      const body = truncated ? input.body.subarray(0, MAX_BODY_BYTES) : input.body;
      const info = insertStmt.run(input.ts, input.upstreamRoute, input.upstreamPath, body, originalLen, truncated);
      const seq = Number(info.lastInsertRowid);
      // Prune in batches rather than on every write — keeps the row count
      // bounded to at most 2*RETAIN_ROWS while keeping the hot path cheap.
      if (seq % RETAIN_ROWS === 0) {
        pruneStmt.run(RETAIN_ROWS);
      }
      return seq;
    },
    patch(seq, fields) {
      if (fields.responseStatus !== undefined) patchStatus.run(fields.responseStatus, seq);
      if (fields.sectionsJson !== undefined) patchSections.run(fields.sectionsJson, seq);
    },
    list(opts) {
      const rows = listStmt.all(opts.afterSeq, opts.limit) as Array<{
        seq: number;
        ts: number;
        upstream_route: string;
        upstream_path: string;
        request_body: Buffer;
        request_bytes: number;
        truncated: number;
        response_status: number | null;
        sections_json: string | null;
      }>;
      return rows.map((r) => ({
        seq: r.seq,
        ts: r.ts,
        upstreamRoute: r.upstream_route,
        upstreamPath: r.upstream_path,
        requestBody: r.request_body,
        requestBytes: r.request_bytes,
        truncated: r.truncated === 1,
        responseStatus: r.response_status,
        sectionsJson: r.sections_json,
      }));
    },
    close() {
      db.close();
    },
  };
}
