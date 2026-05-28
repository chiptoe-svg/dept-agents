/**
 * One-time startup migration: lift class-pool credentials from `.env`
 * into the owner's per-user credential store.
 *
 * Why: Phase C-1 makes "the class pool" = the owner's per-user creds
 * (same store students use). Without this migration, an instructor who
 * had OPENAI_API_KEY etc. in .env before would see "Not connected" on
 * the LLM Providers card even though the credential-proxy still finds
 * the key via its .env fallback chain. This migration makes the card
 * the source of truth.
 *
 * Scope: API keys only. OAuth tokens in .env (e.g. CLAUDE_CODE_OAUTH_TOKEN)
 * are migrated as api-keys would create broken oauth records (no refresh
 * token, no expiry, no account email). Leave OAuth-only entries in .env
 * — the proxy still finds them; the instructor can re-connect via the
 * LLM Providers card to bring them into the new store cleanly.
 *
 * Idempotency: a marker file `data/.env-to-owner-migration-done`
 * prevents re-runs. Delete the marker to force the migration to re-run
 * (e.g. after adding a new mapping below).
 *
 * Non-overwrite: if the owner already has creds for a spec, the .env
 * value is skipped — the LLM Providers card's value wins.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { addApiKey, loadStudentProviderCreds } from './student-provider-auth.js';
import { getOwnerUserId } from './modules/permissions/db/user-roles.js';

const MARKER_FILENAME = '.env-to-owner-migration-done';

const MAPPINGS: Array<{ envKey: string; specId: string }> = [
  { envKey: 'ANTHROPIC_API_KEY', specId: 'claude' },
  { envKey: 'OPENAI_API_KEY', specId: 'codex' },
  { envKey: 'OPENAI_PLATFORM_API_KEY', specId: 'openai-platform' },
  { envKey: 'CAMPUS_LLM_API_KEY', specId: 'clemson' },
  { envKey: 'OMLX_API_KEY', specId: 'omlx' },
];

export interface MigrationResult {
  /** false when the marker already existed or no owner is configured. */
  ran: boolean;
  /** Spec ids that received fresh creds from .env on this run. */
  migrated: string[];
  /** Spec ids where the owner already had creds; .env value left untouched. */
  skipped: string[];
}

function markerPath(): string {
  return path.join(process.cwd(), 'data', MARKER_FILENAME);
}

export function runEnvToOwnerMigration(): MigrationResult {
  const marker = markerPath();
  if (fs.existsSync(marker)) {
    return { ran: false, migrated: [], skipped: [] };
  }
  const ownerId = getOwnerUserId();
  if (!ownerId) {
    // Pre-/setup install or solo no-owner install: do not mark done so
    // the migration re-runs the next time the host starts with an owner.
    return { ran: false, migrated: [], skipped: [] };
  }
  const env = readEnvFile(MAPPINGS.map((m) => m.envKey));
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const { envKey, specId } of MAPPINGS) {
    const value = env[envKey];
    if (!value) continue;
    if (loadStudentProviderCreds(ownerId, specId)) {
      skipped.push(specId);
      continue;
    }
    addApiKey(ownerId, specId, value);
    migrated.push(specId);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());
  return { ran: true, migrated, skipped };
}
