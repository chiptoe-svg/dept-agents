/**
 * Filesystem layout for per-student credential files.
 *
 * Single source of truth so the OAuth callback (which writes them) and
 * the credential proxy (which reads them) agree on where a given
 * student's per-provider creds live. As more per-provider per-student
 * resolvers land (Phase 4 — Anthropic / OpenAI / custom OpenAI-
 * compatible), they all hang off the same `student-creds/<sanitized>/`
 * directory.
 *
 * `sanitizeUserIdForPath` keeps the directory name safe across
 * filesystems by squashing anything outside [A-Za-z0-9_-] to `_`.
 * E.g. `class:student_03` → `class_student_03`.
 */
import path from 'path';

import { DATA_DIR } from './config.js';

export function sanitizeUserIdForPath(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** `data/student-google-auth/<sanitized>/credentials.json` */
export function studentGwsCredentialsPath(userId: string): string {
  return path.join(DATA_DIR, 'student-google-auth', sanitizeUserIdForPath(userId), 'credentials.json');
}
