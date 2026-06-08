/**
 * Per-student LLM provider credential storage. Mirrors
 * student-google-auth.ts (Phase 14) with three additions:
 *   - `active` field designates which auth method the proxy uses
 *   - addApiKey/addOAuth auto-set active when adding to empty store
 *   - clearMethod removes the file entirely when both methods are gone
 *
 * Path: data/user-provider-creds/<sanitized_user_id>/<providerId>.json
 * File mode 0o600, dir mode 0o700 (chmod after mkdir for existing-dir case).
 * Path sanitization shares student-creds-paths.ts with student-google-auth.ts.
 */
import fs from 'fs';
import path from 'path';

import { userProviderCredsPath } from './student-creds-paths.js';

type ApiKeyCreds = { value: string; addedAt: number };
type OAuthCreds = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account?: string;
  addedAt: number;
};

export type UserProviderCreds = {
  apiKey?: ApiKeyCreds;
  oauth?: OAuthCreds;
  active: 'apiKey' | 'oauth';
};

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on create; enforce on existing dirs
  fs.chmodSync(dir, 0o700);
}

function writeAtomic(file: string, data: object): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadUserProviderCreds(userId: string, providerId: string): UserProviderCreds | null {
  try {
    const raw = fs.readFileSync(userProviderCredsPath(userId, providerId), 'utf-8');
    return JSON.parse(raw) as UserProviderCreds;
  } catch {
    return null;
  }
}

export function hasUserProviderCreds(userId: string, providerId: string): boolean {
  return loadUserProviderCreds(userId, providerId) !== null;
}

export function addApiKey(userId: string, providerId: string, apiKey: string): void {
  const file = userProviderCredsPath(userId, providerId);
  ensureDir(file);
  const existing = loadUserProviderCreds(userId, providerId);
  const next: UserProviderCreds = existing
    ? { ...existing, apiKey: { value: apiKey, addedAt: Date.now() } }
    : { apiKey: { value: apiKey, addedAt: Date.now() }, active: 'apiKey' };
  writeAtomic(file, next);
}

export function addOAuth(
  userId: string,
  providerId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; account?: string },
): void {
  const file = userProviderCredsPath(userId, providerId);
  ensureDir(file);
  const existing = loadUserProviderCreds(userId, providerId);
  const oauthEntry: OAuthCreds = { ...tokens, addedAt: Date.now() };
  const next: UserProviderCreds = existing
    ? { ...existing, oauth: oauthEntry }
    : { oauth: oauthEntry, active: 'oauth' };
  writeAtomic(file, next);
}

export function setActiveMethod(userId: string, providerId: string, active: 'apiKey' | 'oauth'): void {
  const existing = loadUserProviderCreds(userId, providerId);
  if (!existing) throw new Error(`no creds for ${userId}/${providerId}`);
  if (active === 'apiKey' && !existing.apiKey) throw new Error('cannot activate apiKey: not set');
  if (active === 'oauth' && !existing.oauth) throw new Error('cannot activate oauth: not set');
  writeAtomic(userProviderCredsPath(userId, providerId), { ...existing, active });
}

export function clearMethod(userId: string, providerId: string, which: 'apiKey' | 'oauth'): void {
  const existing = loadUserProviderCreds(userId, providerId);
  if (!existing) return;
  const remaining: UserProviderCreds = { ...existing };
  delete remaining[which];
  const file = userProviderCredsPath(userId, providerId);
  if (!remaining.apiKey && !remaining.oauth) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  if (remaining.active === which) {
    remaining.active = which === 'apiKey' ? 'oauth' : 'apiKey';
  }
  writeAtomic(file, remaining);
}
