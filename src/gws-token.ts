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
 * wrapper is what lets `getGoogleAccessTokenForAgentGroup` resolve a
 * caller's own token. There is no owner/instructor fallback: a group
 * with no personal Google credentials of its own resolves to `null`,
 * full stop. This is a hard security boundary — no agent may operate
 * inside the owner's Drive/Sheets/Docs/Slides account.
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
 * Instructor / owner token — the host's `~/.config/gws/credentials.json`.
 *
 * NOT used by `getGoogleAccessTokenForAgentGroup` (no agent group may fall
 * back to this). Kept for host-initiated, non-agent email sending — see
 * `gmail-send.ts`, used by the classroom-PIN and bulk-token-distribution
 * flows, which authenticate as the owner directly and are not reachable
 * from any agent tool call.
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

export interface GwsTokenResolution {
  token: string;
  /** Always 'self' — every resolution is the calling group's own token. */
  principal: 'self';
}

/**
 * Resolve the calling agent group's OWN Google OAuth token — never the
 * owner's. Returns `null` if the group has no personal Google credentials
 * on disk (i.e. hasn't connected its own Google account).
 *
 * There is no fallback to the owner/instructor token here. That fallback
 * used to exist and was the reason Drive/Sheets/Docs/Slides tools could
 * silently operate inside the owner's Drive for any agent group without
 * its own credentials — it has been removed as a hard security boundary.
 */
export async function getGoogleAccessTokenForAgentGroup(
  agentGroupId: string | null,
): Promise<GwsTokenResolution | null> {
  if (!agentGroupId) return null;
  const studentToken = await getStudentGoogleAccessTokenForAgentGroup(agentGroupId);
  if (!studentToken) return null;
  return { token: studentToken, principal: 'self' };
}

/** Test hook — drop the in-memory token cache. */
export function _resetTokenCacheForTest(): void {
  tokenCache.clear();
}
