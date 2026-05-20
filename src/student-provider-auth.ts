/**
 * Per-student LLM provider credential storage. Mirrors
 * student-google-auth.ts (Phase 14) with three additions:
 *   - `active` field designates which auth method the proxy uses
 *   - addApiKey/addOAuth auto-set active when adding to empty store
 *   - clearMethod removes the file entirely when both methods are gone
 *
 * Path: data/student-provider-creds/<sanitized_user_id>/<providerId>.json
 * File mode 0o600, dir mode 0o700 (chmod after mkdir for existing-dir case).
 */
import fs from 'fs';
import path from 'path';

const ROOT_DIR_NAME = 'data/student-provider-creds';

type ApiKeyCreds = { value: string; addedAt: number };
type OAuthCreds = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account?: string;
  addedAt: number;
};

export type StudentProviderCreds = {
  apiKey?: ApiKeyCreds;
  oauth?: OAuthCreds;
  active: 'apiKey' | 'oauth';
};

function sanitizeUserId(userId: string): string {
  return userId.replace(/[/\\]/g, '_').replace(/:/g, '_').replace(/@/g, '_at_');
}

function credsRoot(): string {
  return path.join(process.cwd(), ROOT_DIR_NAME);
}

function credsDir(userId: string): string {
  return path.join(credsRoot(), sanitizeUserId(userId));
}

function credsFile(userId: string, providerId: string): string {
  return path.join(credsDir(userId), `${providerId}.json`);
}

function ensureDir(userId: string): string {
  const dir = credsDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync mode only applies on create; enforce on existing dirs
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeAtomic(file: string, data: object): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadStudentProviderCreds(userId: string, providerId: string): StudentProviderCreds | null {
  try {
    const raw = fs.readFileSync(credsFile(userId, providerId), 'utf-8');
    return JSON.parse(raw) as StudentProviderCreds;
  } catch {
    return null;
  }
}

export function hasStudentProviderCreds(userId: string, providerId: string): boolean {
  return loadStudentProviderCreds(userId, providerId) !== null;
}

export function addApiKey(userId: string, providerId: string, apiKey: string): void {
  ensureDir(userId);
  const existing = loadStudentProviderCreds(userId, providerId);
  const next: StudentProviderCreds = existing
    ? { ...existing, apiKey: { value: apiKey, addedAt: Date.now() } }
    : { apiKey: { value: apiKey, addedAt: Date.now() }, active: 'apiKey' };
  writeAtomic(credsFile(userId, providerId), next);
}

export function addOAuth(
  userId: string,
  providerId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; account?: string },
): void {
  ensureDir(userId);
  const existing = loadStudentProviderCreds(userId, providerId);
  const oauthEntry: OAuthCreds = { ...tokens, addedAt: Date.now() };
  const next: StudentProviderCreds = existing
    ? { ...existing, oauth: oauthEntry }
    : { oauth: oauthEntry, active: 'oauth' };
  writeAtomic(credsFile(userId, providerId), next);
}

export function setActiveMethod(userId: string, providerId: string, active: 'apiKey' | 'oauth'): void {
  const existing = loadStudentProviderCreds(userId, providerId);
  if (!existing) throw new Error(`no creds for ${userId}/${providerId}`);
  if (active === 'apiKey' && !existing.apiKey) throw new Error('cannot activate apiKey: not set');
  if (active === 'oauth' && !existing.oauth) throw new Error('cannot activate oauth: not set');
  writeAtomic(credsFile(userId, providerId), { ...existing, active });
}

export function clearMethod(userId: string, providerId: string, which: 'apiKey' | 'oauth'): void {
  const existing = loadStudentProviderCreds(userId, providerId);
  if (!existing) return;
  const remaining: StudentProviderCreds = { ...existing };
  delete remaining[which];
  if (!remaining.apiKey && !remaining.oauth) {
    try {
      fs.unlinkSync(credsFile(userId, providerId));
    } catch {
      /* ignore */
    }
    return;
  }
  if (remaining.active === which) {
    remaining.active = which === 'apiKey' ? 'oauth' : 'apiKey';
  }
  writeAtomic(credsFile(userId, providerId), remaining);
}
