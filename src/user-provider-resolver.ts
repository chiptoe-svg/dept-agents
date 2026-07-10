/**
 * Per-user credential resolver, installed as the trunk userCredsHook at
 * startup. Decides whose credentials each LLM request spends.
 *
 * Resolution (per request):
 *   1. userIdForAgentGroup(agentGroupId) — the group's member per the
 *      entity model (agent_group_members). No member → backstop.
 *   2. loadUserProviderCreds(userId, providerId) — the user's own creds.
 *      If present: branch on creds.active; refresh OAuth if expiry near.
 *      If the requested provider's bucket is empty, a sibling spec's API
 *      key may satisfy it (see SIBLING_API_KEY_SPECS).
 *   3. Otherwise null → the credential proxy attaches the department
 *      .env credential (the backstop). Connecting your own account is
 *      OPTIONAL — there is no per-class policy and no forbidden /
 *      connect_required sentinel. Backstop use is recorded via the
 *      recordBackstop hook so the operator can see who runs on the
 *      department account.
 */
import { request as httpsRequest } from 'https';

import type { ResolvedCreds } from './credential-proxy.js';
import { loadUserProviderCreds, addOAuth } from './user-provider-auth.js';
import { userIdForAgentGroup } from './provisioning/agent-group-user.js';
import { getProviderSpec } from './providers/auth-registry.js';

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

// Recorder hook — Task 2 installs the real one; defaults to no-op so this
// module has no hard dependency on the backstop store.
let recordBackstop: (agentGroupId: string, providerId: string) => void = () => {};

export function setBackstopRecorder(fn: (agentGroupId: string, providerId: string) => void): void {
  recordBackstop = fn;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// API keys are interchangeable across siblings inside a single user-facing
// provider group: an OpenAI `sk-…` key works for both the codex (/openai/)
// and openai-platform (/openai-platform/) proxy routes. When the user
// pastes via the canonical-spec cred dialog (codex), their openai-platform
// bucket stays empty — a model entry routing through /openai-platform/
// would 502 without this fallback. OAuth tokens are NOT cross-spec —
// they're issued for one specific provider.
const SIBLING_API_KEY_SPECS: Record<string, string[]> = {
  codex: ['openai-platform'],
  'openai-platform': ['codex'],
};

export async function resolveUserCreds(agentGroupId: string, providerId: string): Promise<ResolvedCreds> {
  const userId = userIdForAgentGroup(agentGroupId);
  if (userId) {
    const creds = loadUserProviderCreds(userId, providerId);
    // Sibling fallback: try a paired spec's API key when the requested one
    // is empty (OpenAI's two routes share API keys; see SIBLING_API_KEY_SPECS).
    if (!creds || (!creds.apiKey && !creds.oauth)) {
      for (const sib of SIBLING_API_KEY_SPECS[providerId] ?? []) {
        const sibCreds = loadUserProviderCreds(userId, sib);
        if (sibCreds?.apiKey?.value) {
          return { kind: 'apiKey', value: sibCreds.apiKey.value };
        }
      }
    }
    if (creds) {
      if (creds.active === 'apiKey' && creds.apiKey) {
        return { kind: 'apiKey', value: creds.apiKey.value };
      }
      if (creds.active === 'oauth' && creds.oauth) {
        const needsRefresh = creds.oauth.expiresAt - Date.now() < REFRESH_BUFFER_MS;
        if (needsRefresh) {
          const refreshed = await oauthRefresher(creds.oauth.refreshToken, providerId);
          if (refreshed) {
            addOAuth(userId, providerId, { ...refreshed, account: creds.oauth.account });
            return { kind: 'oauth', accessToken: refreshed.accessToken };
          }
          // refresh failed → fall through to the department backstop
        } else {
          return { kind: 'oauth', accessToken: creds.oauth.accessToken };
        }
      }
    }
  }
  // No usable per-user credential → the credential proxy attaches the
  // department .env credential (the backstop). Record it so the operator can
  // see who is running on the department account. Connect is OPTIONAL: there is
  // no per-class policy and no forbidden/connect_required branch here.
  recordBackstop(agentGroupId, providerId);
  return null;
}
