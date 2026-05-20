/**
 * Per-student Google OAuth credential file management.
 *
 * Writer side for the per-student GWS credentials stored at
 * `data/student-google-auth/<sanitized_user_id>/credentials.json`.
 * The reader side lives in `gws-token.ts` — specifically
 * `getStudentGoogleAccessTokenForAgentGroup`, which calls
 * `studentGwsCredentialsPath` and reads the file written here.
 *
 * Path resolution delegates entirely to `studentGwsCredentialsPath`
 * from `student-creds-paths.ts` — no inline path building here.
 */
import fs from 'fs';
import path from 'path';

import type { GwsCredentialsJson } from './gws-auth.js';
import { log } from './log.js';
import { studentGwsCredentialsPath } from './student-creds-paths.js';

/**
 * Write per-student GWS credentials to disk. Creates the directory
 * (mode 0o700) if absent. Atomic write via tmp+rename so a partial
 * write can't corrupt an existing file that gws-token.ts is reading
 * concurrently. File mode 0o600 — sensitive (contains refresh_token).
 *
 * Overwrites any existing file at the same path. Caller responsibility
 * to clear the in-memory tokenCache afterward (call _resetTokenCacheForTest
 * from gws-token.ts, or rely on the cache's natural TTL).
 */
export function writeStudentCredentials(userId: string, creds: GwsCredentialsJson): void {
  const p = studentGwsCredentialsPath(userId);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // enforce: mkdirSync doesn't tighten an existing dir
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  log.debug('Per-student GWS credentials written', { userId, path: p });
}

/** True if data/student-google-auth/<sanitized>/credentials.json exists. */
export function hasStudentCredentials(userId: string): boolean {
  return fs.existsSync(studentGwsCredentialsPath(userId));
}

/**
 * Returns the parsed credentials or null when:
 *   - the file doesn't exist
 *   - the file is unreadable
 *   - the JSON parse fails
 *   - required fields (client_id, client_secret, refresh_token) are missing
 * Never throws.
 */
export function loadStudentCredentials(userId: string): GwsCredentialsJson | null {
  const p = studentGwsCredentialsPath(userId);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GwsCredentialsJson>;
    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
      log.warn('Per-student GWS credentials missing required fields', { userId, path: p });
      return null;
    }
    return parsed as GwsCredentialsJson;
  } catch (err) {
    log.warn('Failed to load per-student GWS credentials', { userId, path: p, err: String(err) });
    return null;
  }
}

/**
 * Delete the per-student credentials file. No-op if the file doesn't
 * exist. Used by the future disconnect flow.
 */
export function clearStudentCredentials(userId: string): void {
  const p = studentGwsCredentialsPath(userId);
  try {
    fs.rmSync(p, { force: true });
    log.debug('Per-student GWS credentials cleared', { userId, path: p });
  } catch (err) {
    log.warn('Failed to clear per-student GWS credentials', { userId, path: p, err: String(err) });
  }
}
