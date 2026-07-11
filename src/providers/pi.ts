/**
 * Host-side container config for the `pi` provider.
 *
 * Pi can route to many model providers (anthropic, openai-codex, deepseek,
 * openrouter, etc.). Credential injection in classroom is layered:
 *
 *   - anthropic         → ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY placeholder
 *                         are already set by container-runner's standard env.
 *                         The credential-proxy rewrites x-api-key on the wire
 *                         and consults the per-student / class-pool resolver.
 *                         (Personal injected ANTHROPIC_AUTH_TOKEN here because
 *                         OneCLI required Bearer + a magic prefix; the proxy
 *                         doesn't.)
 *
 *   - openai-codex      → Reads /workspace/.pi-auth/auth.json (mounted per-session
 *                         from the RESOLVED USER's own codex OAuth — the group's
 *                         member per the entity model, agent_group_members —
 *                         when they have connected their ChatGPT subscription.
 *                         The owner's personal ~/.codex/auth.json is provisioned
 *                         ONLY into the owner's own group; every other group
 *                         gets NO auth.json when its user has no codex OAuth
 *                         (this lane talks to chatgpt.com directly, bypassing
 *                         the credential proxy, so there is no legitimate
 *                         department backstop — an auth error is correct).
 *                         Pi adapts chatgpt-mode tokens via adaptForeignAuth,
 *                         refreshes via getOAuthApiKey. Mount is rw because pi
 *                         rewrites the file on token refresh — and we reconcile
 *                         refreshed tokens back into per-user storage on the
 *                         next spawn. This is the agent-path counterpart to the
 *                         credential-proxy resolver for proxy-routed providers.
 *
 *   - other providers   → Direct env var (DEEPSEEK_API_KEY, GROQ_API_KEY, ...)
 *                         pulled from the host .env if set. Pi calls those
 *                         APIs directly — the credential-proxy doesn't route
 *                         them.
 *
 * No NO_PROXY injection (personal needed it because OneCLI's gateway 401'd on
 * unmatched hosts; classroom's credential-proxy is path-prefix based and
 * passes unmatched hosts straight through).
 *
 * Codex auth.json is provisioned per the rules above; pi-specific
 * env-passthroughs are always injected. Pi reads the one matching its active
 * model_provider at runtime — unused paths are harmless.
 */
import fs from 'fs';
import path from 'path';

import { extractRefreshedFromAuthJson, userCredsToCodexAuthJson } from '../codex-auth-json.js';
import { isOwner } from '../modules/permissions/db/user-roles.js';
import { userIdForAgentGroup } from '../provisioning/agent-group-user.js';
import { readEnvFile } from '../env.js';
import { addOAuth, loadUserProviderCreds } from '../user-provider-auth.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Direct-API providers pi can route to that classroom does NOT intercept via
// the credential-proxy. The env var name matches what pi-auth.ts reads in
// PLACEHOLDER_ENV_BY_PROVIDER.
const DIRECT_API_ENV_VARS = [
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
];

/**
 * Resolve the auth.json source for this session's pi-auth dir.
 *
 *   1. Resolve the group's user via the entity model —
 *      userIdForAgentGroup(agentGroupId), i.e. agent_group_members — NOT
 *      the classroom roster.
 *   2. Reconcile any refreshed tokens left in the existing auth.json from
 *      a prior container spawn — pi rewrites the file on refresh, but a
 *      fresh per-user write would otherwise discard those.
 *   3. If the resolved user has a usable codex OAuth (`codex` providerId,
 *      active=oauth), write THEIR auth.json — their ChatGPT turns bill to
 *      them.
 *   4. Otherwise, the owner's personal `~/.codex/auth.json` is copied ONLY
 *      when the resolved user IS the owner (their own group). For any other
 *      group — no member, no codex OAuth, or active=apiKey (chatgpt.com is
 *      not an API-key endpoint) — write NOTHING and remove any stale file.
 *      The openai-codex lane bypasses the credential proxy, so there is no
 *      legitimate department backstop here; pi failing with an auth error
 *      is the correct outcome. NEVER copy the owner's tokens into a
 *      non-owner container.
 *
 * Pi writes its refresh writeback to the SAME auth.json file we provision.
 * On the NEXT spawn, extractRefreshedFromAuthJson() reads that writeback
 * and we addOAuth() the freshest tokens to the user's storage before
 * overwriting. So the refresh round-trip survives container exits as long
 * as a follow-up spawn happens before the refresh token expires (~30 days).
 */
function provisionPiAuth(piAuthDir: string, agentGroupId: string, hostHome: string | undefined): void {
  const targetFile = path.join(piAuthDir, 'auth.json');

  // Test seam / safety: the entity-model lookup hits the central DB.
  // Tolerate the unlikely case where the DB isn't initialized (e.g., very
  // early boot) by treating it as "no resolved user".
  let userId: string | null = null;
  try {
    userId = userIdForAgentGroup(agentGroupId);
  } catch {
    userId = null;
  }

  if (userId) {
    // Connect is optional — a user's own codex OAuth is used when present.

    // Reconcile any post-refresh tokens pi left behind on the prior spawn,
    // BEFORE we overwrite or remove the file.
    if (fs.existsSync(targetFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(targetFile, 'utf-8')) as unknown;
        const refreshed = extractRefreshedFromAuthJson(raw);
        const stored = loadUserProviderCreds(userId, 'codex');
        if (refreshed && stored?.oauth && refreshed.refreshToken !== stored.oauth.refreshToken) {
          addOAuth(userId, 'codex', {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            account: stored.oauth.account,
          });
        }
      } catch {
        // Malformed prior auth.json — fall through to overwrite.
      }
    }

    const userCreds = loadUserProviderCreds(userId, 'codex');
    const userAuth = userCredsToCodexAuthJson(userCreds);
    if (userAuth) {
      fs.writeFileSync(targetFile, JSON.stringify(userAuth, null, 2), { mode: 0o600 });
      return;
    }
    // No usable codex OAuth — owner-only branch below decides what remains.
  }

  // The owner's personal ~/.codex/auth.json may be provisioned ONLY into the
  // owner's own group. Determine ownership via the permissions layer.
  let resolvedUserIsOwner = false;
  if (userId) {
    try {
      resolvedUserIsOwner = isOwner(userId);
    } catch {
      resolvedUserIsOwner = false;
    }
  }

  if (!resolvedUserIsOwner) {
    // Write NOTHING — and scrub any auth.json a previous (pre-fix) spawn may
    // have left in this session dir, so stale owner tokens don't stay mounted.
    try {
      fs.rmSync(targetFile, { force: true });
    } catch {
      // Best effort — an unremovable stale file must not block the spawn.
    }
    return;
  }

  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, targetFile);
    }
  }
}

registerProviderContainerConfig('pi', (ctx) => {
  // Per-session pi-auth dir; pi reads /workspace/.pi-auth/auth.json.
  const piAuthDir = path.join(ctx.sessionDir, 'pi-auth');
  fs.mkdirSync(piAuthDir, { recursive: true });

  provisionPiAuth(piAuthDir, ctx.agentGroupId, ctx.hostEnv.HOME);

  // Pi-routed direct-API keys: forward only if set in the host .env (and not
  // already in process.env).
  const envFromDotenv = readEnvFile(DIRECT_API_ENV_VARS);
  const directKeys: Record<string, string> = {};
  for (const name of DIRECT_API_ENV_VARS) {
    const value = ctx.hostEnv[name] ?? envFromDotenv[name];
    if (value) directKeys[name] = value;
  }

  // Plumb session-id and host MCP URL through env so the container-side
  // adapter can construct the HTTP MCP bridge. NANOCLAW_HOST_MCP_URL is
  // optional — if unset, pi-mcp-bridge skips the HTTP bridge.
  const sessionId = path.basename(ctx.sessionDir);

  return {
    mounts: [{ hostPath: piAuthDir, containerPath: '/workspace/.pi-auth', readonly: false }],
    env: {
      ...directKeys,
      NANOCLAW_SESSION_ID: sessionId,
    },
  };
});

// Exported for unit tests.
export { provisionPiAuth as _provisionPiAuthForTests };
