/**
 * Anthropic / Claude model adapter.
 *
 * Id pattern: `claude-<tier>-<major>-<minor>[-<date>]` where `<tier>` is
 * one of `opus` / `sonnet` / `haiku`. Alias = the tier name; one model
 * per tier is shown in `/model`.
 *
 * Custom endpoint via `ANTHROPIC_BASE_URL` (same env var the credential
 * proxy reads — keeping them in sync means custom-host setups configure
 * one variable, not two).
 *
 * Auth fallback chain:
 *   1. `ANTHROPIC_API_KEY` (env) → `x-api-key`
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` (env) → Bearer
 *   3. `~/.claude/.credentials.json` access token → Bearer
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import type { AuthHeader, ModelHint, ModelProviderAdapter, ParsedModel } from './types.js';

const NOTES: Record<string, string> = {
  opus: 'Opus — strongest reasoning',
  sonnet: 'Sonnet — balanced',
  haiku: 'Haiku — fast/cheap',
};

const STATIC_FALLBACK: ModelHint[] = [
  { id: 'claude-opus-4-7', alias: 'opus', note: NOTES.opus },
  { id: 'claude-sonnet-4-6', alias: 'sonnet', note: NOTES.sonnet },
  { id: 'claude-haiku-4-5-20251001', alias: 'haiku', note: NOTES.haiku },
];

interface ClaudeCredsFile {
  claudeAiOauth?: { accessToken: string };
}

function getAuth(): AuthHeader | null {
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
  if (env.ANTHROPIC_API_KEY) return { name: 'x-api-key', value: env.ANTHROPIC_API_KEY };
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (oauth) return { name: 'authorization', value: `Bearer ${oauth}` };
  // Fallback: Claude CLI credentials file
  try {
    const credPath = path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as ClaudeCredsFile;
      const token = creds.claudeAiOauth?.accessToken;
      if (token) return { name: 'authorization', value: `Bearer ${token}` };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseId(id: string): ParsedModel | null {
  const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const tier = m[1];
  return {
    id,
    alias: tier,
    bucket: tier,
    rank: [parseInt(m[2], 10), parseInt(m[3], 10), m[4] ? parseInt(m[4], 10) : 0],
  };
}

/**
 * Take the latest of each tier (opus, sonnet, haiku) in a stable display
 * order — most-capable first. Caller may further cap the count.
 */
function pickTop(parsed: ParsedModel[], maxCount: number): ParsedModel[] {
  const latestByTier = new Map<string, ParsedModel>();
  for (const p of parsed) {
    if (!p.bucket) continue;
    const cur = latestByTier.get(p.bucket);
    if (!cur || compareRank(p.rank, cur.rank) > 0) {
      latestByTier.set(p.bucket, p);
    }
  }
  const order = ['opus', 'sonnet', 'haiku'];
  const ordered = order.map((t) => latestByTier.get(t)).filter((x): x is ParsedModel => x !== undefined);
  return ordered.slice(0, maxCount);
}

/** Component-wise compare. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareRank(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const adapter: ModelProviderAdapter = {
  name: 'claude',
  defaultHost: 'api.anthropic.com',
  envBaseUrlVar: 'ANTHROPIC_BASE_URL',
  modelsPath: '/v1/models',
  extraHeaders: { 'anthropic-version': '2023-06-01' },
  getAuth,
  parseId,
  pickTop,
  noteFor: (alias) => NOTES[alias],
  staticFallback: STATIC_FALLBACK,
};

// Exported for the registry barrel + tests + the static-fallback path in
// model-discovery. Registration happens in `./index.ts` (imperatively,
// after the registry const initializes — top-level `registerModelProvider`
// here would TDZ).
export { adapter as anthropicAdapter, NOTES as CLAUDE_NOTES, STATIC_FALLBACK as STATIC_CLAUDE };
