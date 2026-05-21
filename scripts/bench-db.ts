/**
 * SQLite schema + helpers for data/benchmarks.db.
 *
 * Does NOT share any connection with the host's data/v2.db — bench data is
 * entirely self-contained. Uses better-sqlite3 (already a host dep).
 *
 * Schema:
 *   runs   — one row per (system, request, rep). Aggregated metrics.
 *   events — raw SSE events captured during a run (forensics).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'benchmarks.db');

let _db: Database.Database | null = null;

export function getBenchDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  ensureSchema(_db);
  return _db;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id                     TEXT NOT NULL,
      started_at                 TEXT NOT NULL,
      system_under_test          TEXT NOT NULL,
      provider                   TEXT NOT NULL,
      model                      TEXT NOT NULL,
      harness_config             TEXT,
      request_id                 TEXT NOT NULL,
      repetition                 INTEGER NOT NULL,
      success                    INTEGER NOT NULL,
      output_text                TEXT,
      total_input_tokens         INTEGER,
      total_cached_tokens        INTEGER,
      total_cache_creation_tokens INTEGER,
      total_output_tokens        INTEGER,
      total_reasoning_tokens     INTEGER,
      num_api_calls              INTEGER,
      num_tool_calls             INTEGER,
      latency_ms                 INTEGER,
      cost_usd                   REAL,
      quality_score              REAL,
      programmatic_pass          INTEGER,
      notes                      TEXT,
      PRIMARY KEY (run_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      run_id     TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
}

// ── Catalog rates (mirrors chat.js computeAgentCallCost) ──────────────────

interface CatalogRates {
  costPer1kInUsd: number;
  costPer1kOutUsd: number;
  costPer1kCachedInUsd?: number;
  costPer1kCacheCreationUsd?: number;
}

/**
 * Hard-coded rates for the models used in B1. In B3+ we could query the
 * live model catalog, but for B1 we only exercise claude-sonnet-4-6 and
 * the rates are stable.
 */
const RATES: Record<string, CatalogRates> = {
  'claude/claude-sonnet-4-6': {
    costPer1kInUsd: 0.003,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.0003,
    costPer1kCacheCreationUsd: 0.003 * 1.25,
  },
  'claude/claude-haiku-4-5': {
    costPer1kInUsd: 0.001,
    costPer1kOutUsd: 0.005,
    costPer1kCachedInUsd: 0.0001,
    costPer1kCacheCreationUsd: 0.001 * 1.25,
  },
  // Versioned SDK model names returned by modelUsage keys in the result event.
  // These are the actual identifiers Anthropic's API reports, not the configured alias.
  'claude/claude-haiku-4-5-20251001': {
    costPer1kInUsd: 0.001,
    costPer1kOutUsd: 0.005,
    costPer1kCachedInUsd: 0.0001,
    costPer1kCacheCreationUsd: 0.001 * 1.25,
  },
  'claude/claude-sonnet-4-5': {
    costPer1kInUsd: 0.003,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.0003,
    costPer1kCacheCreationUsd: 0.003 * 1.25,
  },
};

/**
 * Compute cost in USD from token counts, mirroring the logic in chat.js
 * computeAgentCallCost. Returns null if no rates are found.
 *
 * Anthropic-style: input + cacheCreation + cacheRead are disjoint buckets.
 * - input_tokens billed at base rate
 * - cache_creation_input_tokens billed at 1.25x base
 * - cache_read_input_tokens billed at 0.10x base
 */
export function computeCost(
  provider: string,
  model: string,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  tokensCacheRead: number | null | undefined,
  tokensCacheCreation: number | null | undefined,
): number | null {
  if (tokensIn == null || tokensOut == null) return null;
  const key = `${provider}/${model}`;
  const rates = RATES[key];
  if (!rates) return null;

  const baseInRate = rates.costPer1kInUsd;
  const cachedRate = rates.costPer1kCachedInUsd ?? baseInRate * 0.1;
  const creationRate = rates.costPer1kCacheCreationUsd ?? baseInRate * 1.25;

  const creation = tokensCacheCreation ?? 0;
  const read = tokensCacheRead ?? 0;

  let inCost: number;
  if (creation > 0) {
    // Anthropic-style: three disjoint buckets
    inCost =
      (tokensIn / 1000) * baseInRate +
      (creation / 1000) * creationRate +
      (read / 1000) * cachedRate;
  } else {
    // No cache creation — cacheRead is a subset of input (or no caching)
    const billedIn = Math.max(0, tokensIn - read);
    inCost = (billedIn / 1000) * baseInRate + (read / 1000) * cachedRate;
  }

  return inCost + (tokensOut / 1000) * rates.costPer1kOutUsd;
}

// ── DB write helpers ──────────────────────────────────────────────────────

export interface RunRecord {
  run_id: string;
  started_at: string;
  system_under_test: string;
  provider: string;
  model: string;
  harness_config?: string | null;
  request_id: string;
  repetition: number;
  success: number;
  output_text?: string | null;
  total_input_tokens?: number | null;
  total_cached_tokens?: number | null;
  total_cache_creation_tokens?: number | null;
  total_output_tokens?: number | null;
  total_reasoning_tokens?: number | null;
  num_api_calls?: number | null;
  num_tool_calls?: number | null;
  latency_ms?: number | null;
  cost_usd?: number | null;
  quality_score?: number | null;
  programmatic_pass?: number | null;
  notes?: string | null;
}

export function insertRun(record: RunRecord): void {
  const db = getBenchDb();
  db.prepare(`
    INSERT OR REPLACE INTO runs (
      run_id, started_at, system_under_test, provider, model, harness_config,
      request_id, repetition, success, output_text,
      total_input_tokens, total_cached_tokens, total_cache_creation_tokens,
      total_output_tokens, total_reasoning_tokens,
      num_api_calls, num_tool_calls, latency_ms, cost_usd,
      quality_score, programmatic_pass, notes
    ) VALUES (
      @run_id, @started_at, @system_under_test, @provider, @model, @harness_config,
      @request_id, @repetition, @success, @output_text,
      @total_input_tokens, @total_cached_tokens, @total_cache_creation_tokens,
      @total_output_tokens, @total_reasoning_tokens,
      @num_api_calls, @num_tool_calls, @latency_ms, @cost_usd,
      @quality_score, @programmatic_pass, @notes
    )
  `).run({
    run_id: record.run_id,
    started_at: record.started_at,
    system_under_test: record.system_under_test,
    provider: record.provider,
    model: record.model,
    harness_config: record.harness_config ?? null,
    request_id: record.request_id,
    repetition: record.repetition,
    success: record.success,
    output_text: record.output_text ?? null,
    total_input_tokens: record.total_input_tokens ?? null,
    total_cached_tokens: record.total_cached_tokens ?? null,
    total_cache_creation_tokens: record.total_cache_creation_tokens ?? null,
    total_output_tokens: record.total_output_tokens ?? null,
    total_reasoning_tokens: record.total_reasoning_tokens ?? null,
    num_api_calls: record.num_api_calls ?? null,
    num_tool_calls: record.num_tool_calls ?? null,
    latency_ms: record.latency_ms ?? null,
    cost_usd: record.cost_usd ?? null,
    quality_score: record.quality_score ?? null,
    programmatic_pass: record.programmatic_pass ?? null,
    notes: record.notes ?? null,
  });
}

export function insertEvent(runId: string, seq: number, eventJson: string): void {
  getBenchDb()
    .prepare('INSERT OR IGNORE INTO events (run_id, seq, event_json) VALUES (?, ?, ?)')
    .run(runId, seq, eventJson);
}

export function updateRunQuality(runId: string, qualityScore: number, notes: string | null): void {
  getBenchDb()
    .prepare('UPDATE runs SET quality_score = ?, notes = ? WHERE run_id = ?')
    .run(qualityScore, notes, runId);
}

export function getRuns(runGroupId?: string): RunRecord[] {
  const db = getBenchDb();
  if (runGroupId) {
    return db
      .prepare(`SELECT * FROM runs WHERE run_id LIKE ? ORDER BY started_at, request_id, repetition`)
      .all(`${runGroupId}_%`) as RunRecord[];
  }
  return db.prepare('SELECT * FROM runs ORDER BY started_at, request_id, repetition').all() as RunRecord[];
}

export function getDistinctRunGroups(): string[] {
  const db = getBenchDb();
  const rows = db.prepare(`SELECT DISTINCT run_id FROM runs ORDER BY started_at`).all() as { run_id: string }[];
  // run_id = rg_<timestamp>_<request_id>_<rep>  =>  group prefix = "rg_<timestamp>"
  const groups = new Set<string>();
  for (const { run_id } of rows) {
    const match = run_id.match(/^(rg_[^_]+)/);
    if (match) groups.add(match[1]!);
  }
  return [...groups];
}
