/**
 * Classroom-side per-student credential resolver. Installed as the
 * trunk studentCredsHook by the classroom skill at startup.
 *
 * Resolution priority (per request):
 *   1. classroom_roster lookup: agentGroupId → (userId, classId)
 *      If no row → null (solo-install path; trunk falls back to .env)
 *   2. loadStudentProviderCreds(userId, providerId)
 *      If present: branch on creds.active. Refresh OAuth if expiry near.
 *   3. Class Controls policy for classId.providers[providerId]:
 *      provideDefault=true  → host .env (via class-pool reader; null = use trunk .env chain)
 *      provideDefault=false, allowByo=true → connect_required sentinel
 *      allow=false → forbidden sentinel
 *
 * In v1, classId is hardcoded to DEFAULT_CLASS_ID — single-class
 * support is the only shape /add-classroom-controls writes. The
 * `classId` carried through the seams is the seam for multi-class.
 */
import { request as httpsRequest } from 'https';

import type { ResolvedCreds } from './credential-proxy.js';
import { loadStudentProviderCreds, addOAuth } from './student-provider-auth.js';
import { DEFAULT_CLASS_ID, readClassControls } from './channels/playground/api/class-controls.js';
import { lookupRosterByAgentGroupId } from './db/classroom-roster.js';
import { getProviderSpec } from './providers/auth-registry.js';

// Test seam: roster lookup is injectable for unit tests.
let rosterLookup: (gid: string) => { userId: string; classId: string } | null = (gid) => {
  const row = lookupRosterByAgentGroupId(gid);
  return row ? { userId: row.user_id, classId: DEFAULT_CLASS_ID } : null;
};

export function setRosterLookupForTests(fn: (gid: string) => { userId: string; classId: string } | null): void {
  rosterLookup = fn;
}

// Test seam: oauth refresher is injectable.
// Default: real implementation that calls spec.oauth.tokenUrl with refreshGrantBody.
type RefreshedTokens = { accessToken: string; refreshToken: string; expiresAt: number };
let oauthRefresher: (refreshToken: string, providerId: string) => Promise<RefreshedTokens | null> = async (
  refreshToken,
  providerId,
) => {
  const spec = getProviderSpec(providerId);
  if (!spec?.oauth) return null;
  const body = spec.oauth.refreshGrantBody(refreshToken, spec.oauth.clientId);
  const url = new URL(spec.oauth.tokenUrl);
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token ?? refreshToken,
              expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
};

export function setOAuthRefresherForTests(
  fn: (refreshToken: string, providerId: string) => Promise<RefreshedTokens | null>,
): void {
  oauthRefresher = fn;
}

// Test seam: class-pool creds reader is injectable. Default returns null
// (trunk falls back to existing .env chain when this returns null).
let classPoolCreds: (classId: string, providerId: string) => ResolvedCreds = () => null;

export function setClassPoolCredsForTests(fn: (classId: string, providerId: string) => ResolvedCreds): void {
  classPoolCreds = fn;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function resolveStudentCreds(agentGroupId: string, providerId: string): Promise<ResolvedCreds> {
  const ident = rosterLookup(agentGroupId);
  if (!ident) return null;

  const creds = loadStudentProviderCreds(ident.userId, providerId);
  if (creds) {
    if (creds.active === 'apiKey' && creds.apiKey) {
      return { kind: 'apiKey', value: creds.apiKey.value };
    }
    if (creds.active === 'oauth' && creds.oauth) {
      const needsRefresh = creds.oauth.expiresAt - Date.now() < REFRESH_BUFFER_MS;
      if (needsRefresh) {
        const refreshed = await oauthRefresher(creds.oauth.refreshToken, providerId);
        if (refreshed) {
          addOAuth(ident.userId, providerId, { ...refreshed, account: creds.oauth.account });
          return { kind: 'oauth', accessToken: refreshed.accessToken };
        }
      } else {
        return { kind: 'oauth', accessToken: creds.oauth.accessToken };
      }
    }
  }

  const controls = readClassControls();
  const policy = controls.classes[ident.classId]?.providers[providerId];
  // No policy entry = provider was never configured by the instructor.
  // Treat as Mode A: return null so the trunk credential proxy falls through
  // to the host .env chain (instructor's credentials).
  if (!policy) return null;
  if (policy.allow === false) {
    return { kind: 'forbidden', provider: providerId };
  }
  if (policy.provideDefault) {
    return classPoolCreds(ident.classId, providerId);
  }
  return {
    kind: 'connect_required',
    provider: providerId,
    message: `Connect your ${providerId} account to use this model.`,
    connect_url: `/provider-auth/${providerId}/start`,
  };
}
