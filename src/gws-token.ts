/**
 * Google Workspace OAuth access-token resolution.
 *
 * Single source of truth for "what bearer token should this request
 * use?" — consumed by both `credential-proxy.ts` (for `/googleapis/*`
 * passthrough) and `gws-mcp-tools.ts` (for the host MCP's direct API
 * calls).
 *
 * Per-credentials-path token cache so the instructor's token and each
 * student's token cache independently. Refresh is the standard Google
 * OAuth grant_type=refresh_token POST — no library, just `https`.
 *
 * The per-call attribution header set by the container's proxy-fetch
 * wrapper is what lets `getGoogleAccessTokenForAgentGroup` pick a
 * student's token over the instructor's. Missing header / no
 * student_user_id metadata / no per-student creds file all gracefully
 * fall back to the instructor's token — same behavior as the
 * pre-attribution era.
 */
import fs from 'fs';
import path from 'path';
import { request as httpsRequest } from 'https';

import { getAgentGroupMetadata } from './db/agent-groups.js';
import { log } from './log.js';
import { studentGwsCredentialsPath } from './student-creds-paths.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const INSTRUCTOR_GWS_CREDENTIALS_PATH = path.join(
  process.env.HOME || '/home/node',
  '.config',
  'gws',
  'credentials.json',
);

interface GwsCredentials {
  type: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string /*credsPath*/, TokenCacheEntry>();

function readGwsCredentialsFromPath(credsPath: string): GwsCredentials | null {
  try {
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GwsCredentials>;
    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) return null;
    return parsed as GwsCredentials;
  } catch (err) {
    log.warn('Failed to read GWS credentials', { credsPath, err: String(err) });
    return null;
  }
}

/**
 * Get a fresh Google OAuth access token from the credentials.json at
 * `credsPath`. Returns null if the file is missing / malformed.
 * Per-path cache keeps every credentials file's token isolated.
 */
export async function getGoogleAccessTokenForCredsPath(credsPath: string): Promise<string | null> {
  const cached = tokenCache.get(credsPath);
  if (cached && Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  const creds = readGwsCredentialsFromPath(credsPath);
  if (!creds) return null;

  // First-time path: if credentials.json has a fresh access_token + expiry, use it.
  if (creds.access_token && creds.expiry_date && creds.expiry_date > Date.now() + REFRESH_BUFFER_MS) {
    tokenCache.set(credsPath, { accessToken: creds.access_token, expiresAt: creds.expiry_date });
    return creds.access_token;
  }

  // Refresh: exchange refresh_token for a new access_token.
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.error('GWS OAuth refresh failed', {
              credsPath,
              status: res.statusCode,
              body: Buffer.concat(chunks).toString('utf-8').slice(0, 500),
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              access_token: string;
              expires_in: number;
            };
            tokenCache.set(credsPath, {
              accessToken: json.access_token,
              expiresAt: Date.now() + json.expires_in * 1000,
            });
            log.debug('GWS OAuth refresh OK', { credsPath, expiresInMin: Math.round(json.expires_in / 60) });
            resolve(json.access_token);
          } catch (err) {
            log.error('GWS OAuth refresh parse failed', { credsPath, err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.error('GWS OAuth refresh request error', { credsPath, err: String(err) });
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Instructor / class-default token — the host's
 * `~/.config/gws/credentials.json`. Used when no per-call attribution
 * resolves or no per-student creds exist on disk yet.
 */
export function getInstructorGoogleAccessToken(): Promise<string | null> {
  return getGoogleAccessTokenForCredsPath(INSTRUCTOR_GWS_CREDENTIALS_PATH);
}

/**
 * Per-student token via the per-call attribution header. Looks up
 * `agent_groups.metadata.student_user_id` (set by class-feature pair
 * consumers), then reads creds at
 * `data/student-google-auth/<sanitized>/credentials.json` (written by
 * the playground's Google OAuth callback). Returns null on any miss
 * so callers can chain to the instructor token.
 */
export async function getStudentGoogleAccessTokenForAgentGroup(agentGroupId: string): Promise<string | null> {
  const meta = getAgentGroupMetadata(agentGroupId);
  const studentUserId = typeof meta.student_user_id === 'string' ? meta.student_user_id : null;
  if (!studentUserId) return null;
  const credsPath = studentGwsCredentialsPath(studentUserId);
  if (!fs.existsSync(credsPath)) return null;
  const token = await getGoogleAccessTokenForCredsPath(credsPath);
  if (token) {
    log.debug('Per-student GWS token resolved', { agentGroupId, studentUserId });
  }
  return token;
}

/**
 * Caller principal — distinguishes per-student token resolution from
 * instructor-fallback. Mode A / Mode 1 callers always see
 * `instructor-fallback`; Mode B callers with a wired per-student
 * credentials file see `self`. Tools use this to decide whether to
 * run NanoClaw-side ownership checks (Mode A) or trust Google's own
 * boundaries (Mode B).
 */
export type GwsPrincipal = 'self' | 'instructor-fallback';

export interface GwsTokenResolution {
  token: string;
  principal: GwsPrincipal;
}

/**
 * Pick the right Google OAuth token for a caller: per-student first if
 * the agent-group attribution resolves to a per-student credentials
 * file; instructor / class-default otherwise.
 *
 * Graceful fallback chain — missing-attribution, missing-metadata, and
 * missing-creds-file all reduce to "use the instructor's token." Per-
 * student isolation only kicks in once a class deployment has wired
 * the student through the playground OAuth flow.
 *
 * When `options.requirePersonal` is true the function returns null
 * instead of falling back to the instructor token. Gmail (Tier C) and
 * Calendar (Tier D) tools use this gate to refuse to fire until the
 * student has connected their own Google account. Drive/Sheets/Slides
 * tools omit the option (or pass false) to keep Mode A fallback.
 */
export async function getGoogleAccessTokenForAgentGroup(
  agentGroupId: string | null,
  options?: { requirePersonal?: boolean },
): Promise<GwsTokenResolution | null> {
  if (agentGroupId) {
    const studentToken = await getStudentGoogleAccessTokenForAgentGroup(agentGroupId);
    if (studentToken) return { token: studentToken, principal: 'self' };
  }
  if (options?.requirePersonal) return null;
  const instructorToken = await getInstructorGoogleAccessToken();
  if (instructorToken) return { token: instructorToken, principal: 'instructor-fallback' };
  return null;
}

/** Test hook — drop the in-memory token cache. */
export function _resetTokenCacheForTest(): void {
  tokenCache.clear();
}
