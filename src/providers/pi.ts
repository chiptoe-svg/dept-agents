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
 *                         from a per-student copy when the agent group maps to a
 *                         classroom roster row and the student has connected
 *                         their ChatGPT subscription; otherwise from the owner's
 *                         ~/.codex/auth.json class pool). Pi adapts chatgpt-mode
 *                         tokens via adaptForeignAuth, refreshes via
 *                         getOAuthApiKey. Mount is rw because pi rewrites the
 *                         file on token refresh — and we reconcile refreshed
 *                         tokens back into per-student storage on the next spawn.
 *                         This is the agent-path counterpart to the credential-
 *                         proxy resolver for proxy-routed providers.
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
 * Always copy codex auth.json when present + always inject pi-specific
 * env-passthroughs. Pi reads the one matching its active model_provider at
 * runtime — unused paths are harmless.
 */
import fs from 'fs';
import path from 'path';

import { readClassControls } from '../channels/playground/api/class-controls.js';
import { extractRefreshedFromAuthJson, userCredsToCodexAuthJson } from '../codex-auth-json.js';
import { lookupRosterByAgentGroupId } from '../db/classroom-roster.js';
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
 *   1. Roster-lookup the agent group. If it maps to a classroom student
 *      and that student has connected their OpenAI ChatGPT subscription
 *      (`codex` providerId, active=oauth), use their tokens.
 *   2. Reconcile any refreshed tokens left in the existing auth.json from
 *      a prior container spawn — pi rewrites the file on refresh, but a
 *      fresh per-student write would otherwise discard those.
 *   3. Otherwise (no roster, no student creds, or active=apiKey — codex
 *      backend talks to chatgpt.com and won't accept an API key), fall
 *      back to the owner's `~/.codex/auth.json` class pool.
 *
 * Pi writes its refresh writeback to the SAME auth.json file we provision.
 * On the NEXT spawn, extractRefreshedFromAuthJson() reads that writeback
 * and we addOAuth() the freshest tokens to the student's storage before
 * overwriting. So the refresh round-trip survives container exits as long
 * as a follow-up spawn happens before the refresh token expires (~30 days).
 */
function provisionPiAuth(piAuthDir: string, agentGroupId: string, hostHome: string | undefined): void {
  const targetFile = path.join(piAuthDir, 'auth.json');

  // Test seam / safety: roster lookup hits the central DB. Tolerate the
  // unlikely case where the DB isn't initialized (e.g., very early boot)
  // by treating it as "no roster".
  let rosterEntry: { user_id: string; agent_group_id: string | null } | null = null;
  try {
    rosterEntry = lookupRosterByAgentGroupId(agentGroupId);
  } catch {
    rosterEntry = null;
  }

  if (rosterEntry) {
    // Class Controls gate — mirrors the credential-proxy resolver contract
    // for proxy-routed providers. If the instructor has disabled codex for
    // this class (`allow: false`), we deliberately leave auth.json empty
    // so pi-ai 401s on first request. The container still starts; the
    // failure surfaces to the student as a model error.
    const controls = readClassControls();
    // The roster row's classId is currently fixed to the default class;
    // when multi-class lands we'll thread the class id off the roster
    // entry. Until then DEFAULT_CLASS_ID matches what the resolver uses.
    const policy = controls.classes['default']?.providers['codex'];
    if (policy && policy.allow === false) {
      // Clear any prior auth.json so a stale token doesn't survive the
      // toggle flip.
      if (fs.existsSync(targetFile)) fs.rmSync(targetFile);
      return;
    }

    // Reconcile any post-refresh tokens pi left behind on the prior spawn,
    // BEFORE we overwrite the file with the current per-student creds.
    if (fs.existsSync(targetFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(targetFile, 'utf-8')) as unknown;
        const refreshed = extractRefreshedFromAuthJson(raw);
        const stored = loadUserProviderCreds(rosterEntry.user_id, 'codex');
        if (refreshed && stored?.oauth && refreshed.refreshToken !== stored.oauth.refreshToken) {
          addOAuth(rosterEntry.user_id, 'codex', {
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

    const studentCreds = loadUserProviderCreds(rosterEntry.user_id, 'codex');
    const studentAuth = userCredsToCodexAuthJson(studentCreds);
    if (studentAuth) {
      fs.writeFileSync(targetFile, JSON.stringify(studentAuth, null, 2), { mode: 0o600 });
      return;
    }

    // Student has no codex OAuth. Honor `provideDefault` like the proxy
    // resolver does — if the instructor explicitly disabled class-pool
    // fallback, leave auth.json empty rather than handing the student the
    // owner's tokens.
    if (policy && policy.provideDefault === false) {
      if (fs.existsSync(targetFile)) fs.rmSync(targetFile);
      return;
    }
  }

  // Class pool: owner's ~/.codex/auth.json. Same behaviour as pre-Phase-X.7
  // agent-path codex auth.
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
