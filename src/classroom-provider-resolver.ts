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
 *      provideDefault=true  → owner's per-user creds (the "class pool" =
 *                             the same per-user store students use, just
 *                             keyed by the install owner's userId)
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
import { getOwnerUserId } from './modules/permissions/db/user-roles.js';

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

// Test seam: owner-userId lookup is injectable so unit tests don't need
// to stand up the central DB just to exercise the class-pool path.
let ownerLookup: () => string | null = () => getOwnerUserId();

export function setOwnerLookupForTests(fn: () => string | null): void {
  ownerLookup = fn;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Class-pool credentials reader. Per Phase C-1: the class pool *is* the
// owner's per-user credential store — same shape as student creds, looked
// up via the same loadStudentProviderCreds helper. When the owner has
// nothing connected for a provider this returns null and the proxy 502s
// with "instructor hasn't connected …" (caller's responsibility — see
// credential-proxy serializeResolvedCredsError).
//
// Sync overrides still work: the await in resolveStudentCreds accepts
// both Promise<ResolvedCreds> and ResolvedCreds. Test injections that
// returned the resolved value directly continue to compile.
let classPoolCreds: (classId: string, providerId: string) => Promise<ResolvedCreds> | ResolvedCreds = async (
  _classId,
  providerId,
) => {
  const ownerId = ownerLookup();
  if (!ownerId) return null;
  const creds = loadStudentProviderCreds(ownerId, providerId);
  if (!creds) return null;
  if (creds.active === 'apiKey' && creds.apiKey) {
    return { kind: 'apiKey', value: creds.apiKey.value };
  }
  if (creds.active === 'oauth' && creds.oauth) {
    const needsRefresh = creds.oauth.expiresAt - Date.now() < REFRESH_BUFFER_MS;
    if (needsRefresh) {
      const refreshed = await oauthRefresher(creds.oauth.refreshToken, providerId);
      if (!refreshed) return null;
      addOAuth(ownerId, providerId, { ...refreshed, account: creds.oauth.account });
      return { kind: 'oauth', accessToken: refreshed.accessToken };
    }
    return { kind: 'oauth', accessToken: creds.oauth.accessToken };
  }
  return null;
};

export function setClassPoolCredsForTests(
  fn: (classId: string, providerId: string) => Promise<ResolvedCreds> | ResolvedCreds,
): void {
  classPoolCreds = fn;
}

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
    return await classPoolCreds(ident.classId, providerId);
  }
  return {
    kind: 'connect_required',
    provider: providerId,
    message: `Connect your ${providerId} account to use this model.`,
    connect_url: `/provider-auth/${providerId}/start`,
  };
}
