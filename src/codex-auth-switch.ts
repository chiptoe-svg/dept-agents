/**
 * Codex auth mode switching — mirrors auth-switch.ts for the Claude/Anthropic side.
 *
 * Codex reads auth from ~/.codex/auth.json at container spawn time. Two modes:
 *   chatgpt — uses ChatGPT subscription OAuth tokens (id/access/refresh)
 *   apikey  — uses OPENAI_API_KEY (injected from the credential proxy)
 *
 * Switching keeps a sidecar backup for each mode:
 *   ~/.codex/auth.json.chatgpt-backup
 *   ~/.codex/auth.json.apikey-backup
 *
 * This lets the operator toggle between modes without losing credentials. On
 * switch: save current as <current-mode>-backup, restore <target-mode>-backup.
 * If no backup exists for the target, a minimal placeholder is written instead.
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

export type CodexAuthMode = 'chatgpt' | 'apikey' | 'unknown';

const CODEX_DIR = path.join(process.env.HOME || '/home/nano', '.codex');
const AUTH_PATH = path.join(CODEX_DIR, 'auth.json');
const BACKUP_CHATGPT = path.join(CODEX_DIR, 'auth.json.chatgpt-backup');
const BACKUP_APIKEY = path.join(CODEX_DIR, 'auth.json.apikey-backup');

interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexAuthStatus {
  mode: CodexAuthMode;
  hasOAuthTokens: boolean;
  hasApiKey: boolean;
  lastRefresh: string | null;
}

export function getCodexAuthStatus(): CodexAuthStatus {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      return { mode: 'unknown', hasOAuthTokens: false, hasApiKey: false, lastRefresh: null };
    }
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) as CodexAuthJson;
    const mode: CodexAuthMode =
      auth.auth_mode === 'chatgpt' ? 'chatgpt' : auth.auth_mode === 'apikey' ? 'apikey' : 'unknown';
    return {
      mode,
      hasOAuthTokens: !!(auth.tokens?.refresh_token && auth.tokens?.access_token),
      hasApiKey: !!auth.OPENAI_API_KEY,
      lastRefresh: auth.last_refresh ?? null,
    };
  } catch {
    return { mode: 'unknown', hasOAuthTokens: false, hasApiKey: false, lastRefresh: null };
  }
}

export function switchCodexAuthMode(target: 'chatgpt' | 'apikey'): void {
  const current = getCodexAuthStatus();

  // Save current state to its mode's backup slot before switching.
  if (fs.existsSync(AUTH_PATH) && current.mode !== 'unknown') {
    const backup = current.mode === 'chatgpt' ? BACKUP_CHATGPT : BACKUP_APIKEY;
    fs.copyFileSync(AUTH_PATH, backup);
    fs.chmodSync(backup, 0o600);
  }

  if (target === 'chatgpt') {
    if (!fs.existsSync(BACKUP_CHATGPT)) {
      throw new Error(
        'No ChatGPT OAuth backup found (~/.codex/auth.json.chatgpt-backup). ' +
          'Run `codex login` on this machine first, then try again.',
      );
    }
    fs.copyFileSync(BACKUP_CHATGPT, AUTH_PATH);
    fs.chmodSync(AUTH_PATH, 0o600);
    log.info('codex-auth: switched to chatgpt mode');
  } else {
    if (fs.existsSync(BACKUP_APIKEY)) {
      fs.copyFileSync(BACKUP_APIKEY, AUTH_PATH);
      fs.chmodSync(AUTH_PATH, 0o600);
      log.info('codex-auth: switched to apikey mode (restored backup)');
    } else {
      // Minimal placeholder — OPENAI_API_KEY comes from container env via the credential proxy.
      fs.writeFileSync(AUTH_PATH, JSON.stringify({ auth_mode: 'apikey' }, null, 2), { mode: 0o600 });
      log.info('codex-auth: switched to apikey mode (created placeholder)');
    }
  }
}
