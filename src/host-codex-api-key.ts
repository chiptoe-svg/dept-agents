/**
 * Host-level Codex API-key auth — generic resolver for any codex agent.
 *
 * Mirrors src/class-codex-auth.ts but isn't restricted to classroom folders.
 * When `OPENAI_API_KEY` is set in `.env`, this module:
 *
 *   1. Writes `data/host-codex-auth.json` with the api_key-mode shape that
 *      the codex CLI expects (`auth_mode: "api_key"`, `OPENAI_API_KEY:
 *      <key>`).
 *   2. Registers a Codex auth resolver — fires for any agent group. Since
 *      `registerCodexAuthResolver` unshifts, the resolver registered LAST
 *      wins; import order in src/index.ts puts this after
 *      class-codex-auth, so this one takes precedence for both class and
 *      non-class codex agents when the key is set.
 *
 * Fallback: if `OPENAI_API_KEY` is unset, OR the auth.json write fails,
 * the resolver returns null and the chain falls through to
 * class-codex-auth (which itself falls through to the instructor's
 * ChatGPT OAuth from ~/.codex/auth.json).
 *
 * Rotation: edit `.env`, restart the host. The auth.json is regenerated
 * at startup from the current env value. The credential proxy still
 * substitutes the real key in transit, so the container never sees it
 * in env vars — only the auth.json shape — and the proxy's existing
 * OPENAI_API_KEY=placeholder env binding stays intact.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { registerCodexAuthResolver, type CodexAuthResolver } from './providers/codex.js';

const HOST_AUTH_JSON_PATH = path.join(DATA_DIR, 'host-codex-auth.json');

function writeHostAuthJson(apiKey: string): void {
  // NOTE: auth_mode is "apikey" (no underscore) — that's what the codex CLI
  // actually recognizes. Matches the format `codex login --api-key` produces
  // at ~/.codex/auth.json. The class-codex-auth.ts module upstream had this
  // as "api_key" (with underscore) which silently failed authentication.
  const auth = {
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOST_AUTH_JSON_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
  log.info('Host Codex API-key auth.json written', { path: HOST_AUTH_JSON_PATH });
}

export const hostCodexApiKeyResolver: CodexAuthResolver = () => {
  if (!fs.existsSync(HOST_AUTH_JSON_PATH)) return null;
  return { name: 'host-api-key', path: HOST_AUTH_JSON_PATH };
};

export function initializeHostCodexAuth(): void {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.info('OPENAI_API_KEY not set — host Codex resolver falls through to ChatGPT OAuth');
    return;
  }
  try {
    writeHostAuthJson(apiKey);
  } catch (err) {
    log.warn('Failed to write host codex auth.json — falling back', { err: String(err) });
  }
}

initializeHostCodexAuth();
registerCodexAuthResolver(hostCodexApiKeyResolver);
