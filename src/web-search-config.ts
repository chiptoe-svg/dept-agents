/**
 * Install-wide web-search backend selection, persisted at
 * DATA_DIR/config/web-search.json. Read by the host (to forward
 * WEB_SEARCH_PROVIDER into agent containers) and written by the owner card.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';

export type WebSearchProvider = 'brave' | 'searxng';
const VALID: WebSearchProvider[] = ['brave', 'searxng'];
const DEFAULT: WebSearchProvider = 'searxng';

function configPath(): string {
  return path.join(DATA_DIR, 'config', 'web-search.json');
}

export function readWebSearchProvider(): WebSearchProvider {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { provider?: string };
    return VALID.includes(raw.provider as WebSearchProvider) ? (raw.provider as WebSearchProvider) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function writeWebSearchProvider(provider: WebSearchProvider, updatedBy: string): void {
  const dir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ provider, updatedAt: new Date().toISOString(), updatedBy }, null, 2));
}

// SEARXNG_URL / WEB_SEARCH_API_KEY come from .env, which the launchd host
// (`node dist/index.js`, no --env-file) never loads into process.env — values
// reach the host only via readEnvFile(). process.env still wins as an override
// (dev/tests), then the .env file, then empty.
export function readSearxngUrl(): string {
  return process.env.SEARXNG_URL || readEnvFile(['SEARXNG_URL']).SEARXNG_URL || '';
}

export function readBraveApiKey(): string {
  return process.env.WEB_SEARCH_API_KEY || readEnvFile(['WEB_SEARCH_API_KEY']).WEB_SEARCH_API_KEY || '';
}
