/**
 * Host-side container config for the `pi` provider.
 *
 * Pi can route to many model providers (anthropic, openai-codex, deepseek,
 * openrouter, etc.). Credential injection in classroom is layered:
 *
 *   - anthropic         → ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY placeholder
 *                         are already set by container-runner's standard env.
 *                         The credential-proxy rewrites x-api-key on the wire.
 *                         (Personal injected ANTHROPIC_AUTH_TOKEN here because
 *                         OneCLI required Bearer + a magic prefix; the proxy
 *                         doesn't.)
 *
 *   - openai-codex      → Reads /workspace/.pi-auth/auth.json (mounted per-session
 *                         from the host's ~/.codex/auth.json copy). Pi adapts
 *                         chatgpt-mode tokens via adaptForeignAuth, refreshes
 *                         via getOAuthApiKey. Mount is rw because pi rewrites
 *                         the file on token refresh.
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

import { readEnvFile } from '../env.js';
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

registerProviderContainerConfig('pi', (ctx) => {
  // Copy host's ~/.codex/auth.json into per-session pi-auth dir (if present).
  // Pi reads from /workspace/.pi-auth/auth.json inside the container.
  const piAuthDir = path.join(ctx.sessionDir, 'pi-auth');
  fs.mkdirSync(piAuthDir, { recursive: true });

  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(piAuthDir, 'auth.json'));
    }
  }

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
