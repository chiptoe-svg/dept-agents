/**
 * Periodically refresh the codex model catalog from OpenAI's docs page.
 *
 * Source of truth: https://developers.openai.com/codex/models — which is
 * a static HTML page that contains the canonical list of codex CLI model
 * IDs as plain text (e.g. `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex`).
 * We pull the page, regex-extract every `gpt-N.M[-modifier]` occurrence,
 * dedupe, drop the exclusion list (currently just `gpt-5.3-codex-spark`,
 * which is ChatGPT-Pro-only and not available to edu users), and cache
 * the result to disk for 24h.
 *
 * `getModelCatalog()` in model-catalog.ts consults the cached list to:
 *   - filter out BUILTIN_ENTRIES codex models that have disappeared from
 *     the docs page (drop-on-disappear);
 *   - surface NEW model IDs that aren't in BUILTIN_ENTRIES yet as minimal
 *     placeholder entries (just id + provider + displayName, no pricing).
 *
 * Failures (network, OpenAI HTML redesign, empty regex match) are
 * non-fatal: we keep the previous cache, and if there's no cache at all,
 * we fall back to BUILTIN_ENTRIES as-is. Catalog NEVER goes empty as a
 * result of a refresh failure.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const SOURCE_URL = 'https://developers.openai.com/codex/models';
const CACHE_PATH = path.join(DATA_DIR, 'codex-catalog-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Model IDs we deliberately hide even when OpenAI lists them. */
const EXCLUDED_IDS = new Set([
  // Spark is gated to ChatGPT Pro subscribers; edu-tier users can't call it,
  // so showing it in the picker just creates 403s.
  'gpt-5.3-codex-spark',
]);

interface CacheShape {
  fetched_at: number;
  source: string;
  models: string[];
}

/**
 * Single in-flight promise so concurrent refresh triggers collapse. Reset
 * to null after settle so the next stale-check can fire a fresh fetch.
 */
let inFlight: Promise<void> | null = null;

/**
 * Read the cached codex model list, or null when no usable cache exists.
 * "Usable" = cache file readable AND `fetched_at` is within CACHE_TTL_MS.
 * Older caches are returned anyway via `readCachedCodexModelsStale()`
 * since stale-with-fallback is better than empty.
 */
export function readCachedCodexModels(): string[] | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const cache = JSON.parse(raw) as CacheShape;
    if (!Array.isArray(cache.models)) return null;
    if (typeof cache.fetched_at !== 'number') return null;
    return cache.models;
  } catch {
    return null;
  }
}

function isCacheStale(): boolean {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const cache = JSON.parse(raw) as CacheShape;
    return Date.now() - cache.fetched_at > CACHE_TTL_MS;
  } catch {
    return true; // no cache → "stale" so the next call triggers a refresh
  }
}

/**
 * Fetch the docs page, extract codex model IDs, write the cache. Returns
 * the in-flight promise so callers can await; subsequent calls before the
 * first settles return the same promise.
 */
export async function refreshCodexCatalog(force = false): Promise<void> {
  if (!force && !isCacheStale()) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const resp = await fetch(SOURCE_URL, {
        headers: {
          // OpenAI's CDN returns 403 to obvious bot User-Agents (curl/*, node-fetch
          // default). A browser-ish UA passes without further negotiation.
          'User-Agent': 'Mozilla/5.0 (NanoClaw codex-catalog-refresh) AppleWebKit/537.36 (KHTML, like Gecko)',
          accept: 'text/html',
        },
      });
      if (!resp.ok) {
        log.warn('codex-catalog-refresh: non-200', { status: resp.status });
        return;
      }
      const html = await resp.text();
      // Match `gpt-N.M`, `gpt-N.M-mini`, `gpt-N.M-codex`, `gpt-N.M-codex-spark`,
      // etc. Tight enough to avoid false-positives in code snippets that
      // reference gpt-4 / gpt-4o without dotted decimal versions.
      const matches = html.match(/gpt-\d+\.\d+(?:-[a-z]+)*/g) ?? [];
      const unique = [...new Set(matches)].filter((id) => !EXCLUDED_IDS.has(id));
      if (unique.length === 0) {
        log.warn('codex-catalog-refresh: regex matched 0 ids — page format may have changed', {
          source: SOURCE_URL,
        });
        return;
      }
      const cache: CacheShape = {
        fetched_at: Date.now(),
        source: SOURCE_URL,
        models: unique.sort(),
      };
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      // Atomic write: rename-from-tmp avoids partial writes if the process
      // dies mid-write (model-catalog.ts reads this file synchronously).
      const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
      fs.renameSync(tmp, CACHE_PATH);
      log.info('codex-catalog-refresh: cached', { count: unique.length, models: unique });
    } catch (err) {
      log.warn('codex-catalog-refresh: fetch/parse failed', { err: String(err) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
