import fs from 'fs';
import path from 'path';

import { getEnvApiKey } from '@earendil-works/pi-ai';
import { getOAuthApiKey } from '@earendil-works/pi-ai/oauth';

interface PiAuthResult {
  apiKey: string;
}

const PI_AUTH_FILE = '/workspace/.pi-auth/auth.json';

interface PiOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/**
 * Env vars to check for API-key providers that go direct (not through the
 * credential proxy). The proxy handles anthropic and openai (cloud platform);
 * these are passthrough env vars set by the host for other providers that
 * pi-ai can route to directly, or via proxy if a prefix/BASE_URL is
 * configured. Absent the var, pi falls through to getEnvApiKey().
 *
 * Anthropic is NOT in this table — classroom containers receive
 *   ANTHROPIC_API_KEY=placeholder  (api-key mode) or
 *   CLAUDE_CODE_OAUTH_TOKEN=placeholder  (oauth mode)
 * and the credential proxy at ANTHROPIC_BASE_URL substitutes the real
 * credentials on every request. Pi reads those env vars directly via its
 * own SDK init; we don't need to plumb them through here.
 *
 * openai-codex is NOT in this table either — it uses ChatGPT OAuth from
 * auth.json (chatgpt.com, not OpenAI Platform API), which the proxy does
 * not handle. That path is kept verbatim below.
 *
 * openai (platform) is also NOT here — OPENAI_API_KEY=placeholder is set
 * by the host and the proxy at OPENAI_BASE_URL (/openai/v1 prefix)
 * substitutes the real key.
 */
const PLACEHOLDER_ENV_BY_PROVIDER: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decoded = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    const exp = decoded?.exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function adaptForeignAuth(providerId: string, raw: unknown): Record<string, PiOAuthCredentials> | null {
  if (providerId !== 'openai-codex' || !raw || typeof raw !== 'object') return null;
  const source = raw as {
    tokens?: { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string };
    last_refresh?: string;
  };
  const access = source.tokens?.access_token;
  const refresh = source.tokens?.refresh_token;
  if (!access || !refresh) return null;

  // Prefer the actual JWT exp claim so Pi doesn't trigger premature OAuth
  // refreshes. Codex tokens are long-lived JWTs (often 10+ days). Falling
  // back to last_refresh + 55 min is only for non-JWT access tokens.
  const jwtExp = decodeJwtExp(access);
  const lastRefreshMs = source.last_refresh ? Date.parse(source.last_refresh) : Date.now();
  const baseTime = Number.isFinite(lastRefreshMs) ? lastRefreshMs : Date.now();
  const expires = jwtExp ?? baseTime + 55 * 60 * 1000;

  return {
    'openai-codex': {
      access,
      refresh,
      expires,
      ...(source.tokens?.account_id ? { account_id: source.tokens.account_id } : {}),
      ...(source.tokens?.id_token ? { id_token: source.tokens.id_token } : {}),
    },
  };
}

function readPiAuthCredentials(providerId: string, authPath: string): Record<string, PiOAuthCredentials> | null {
  if (!fs.existsSync(authPath)) return null;
  const raw = readJson(authPath);
  if (raw && typeof raw === 'object' && providerId in (raw as Record<string, unknown>)) {
    return raw as Record<string, PiOAuthCredentials>;
  }
  return adaptForeignAuth(providerId, raw);
}

/**
 * Resolve credentials for a pi-ai provider request.
 *
 * Anthropic (modelProvider: 'anthropic'):
 *   Returns the placeholder env var set by the host container-runner.
 *   The credential proxy at ANTHROPIC_BASE_URL substitutes the real
 *   api-key (x-api-key header) or OAuth token (Authorization: Bearer)
 *   before the request leaves the host. No container-side secret handling.
 *
 * OpenAI-codex (modelProvider: 'openai-codex'):
 *   Reads OAuth credentials from /workspace/.pi-auth/auth.json verbatim.
 *   This path bypasses the proxy because chatgpt.com is not an OpenAI
 *   Platform API endpoint — the proxy does not route it. adaptForeignAuth
 *   converts the Codex CLI desktop-app token format into Pi's OAuth shape.
 *
 * Other providers (deepseek, groq, etc.):
 *   Returns the env var value if present (host-injected placeholder or
 *   real key). Falls through to pi-ai's own getEnvApiKey() if absent.
 */
export async function getPiAuthApiKey(providerId: string, authPath = PI_AUTH_FILE): Promise<PiAuthResult | null> {
  // Anthropic: the credential proxy at ANTHROPIC_BASE_URL substitutes the
  // real credential on every request. WHICH header it substitutes depends
  // on host authMode:
  //   - api-key mode: proxy rewrites x-api-key. ANTHROPIC_API_KEY is set.
  //   - oauth mode: proxy rewrites Authorization: Bearer ONLY when the
  //     request carries an Authorization header. CLAUDE_CODE_OAUTH_TOKEN
  //     is set (placeholder). Pi-ai's Anthropic client decides between
  //     x-api-key and Authorization: Bearer based on the apiKey prefix —
  //     `sk-ant-oat-` triggers Bearer. So in oauth mode we MUST return a
  //     value starting with that prefix, otherwise pi-ai sends x-api-key
  //     and the proxy passes it through unchanged, and Anthropic 401s.
  if (providerId === 'anthropic') {
    if (process.env.ANTHROPIC_API_KEY) {
      return { apiKey: process.env.ANTHROPIC_API_KEY };
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      // The placeholder value itself doesn't matter — the proxy substitutes
      // the real OAuth token in the Authorization header. The prefix is
      // what's load-bearing for pi-ai's header-selection logic.
      return { apiKey: 'sk-ant-oat-placeholder' };
    }
    return null;
  }

  // Clemson RCD + local OMLX: the credential proxy substitutes the real
  // bearer (CAMPUS_LLM_API_KEY or OMLX_API_KEY) at the wire level on the
  // /clemson/* and /omlx/* routes respectively. Pi-ai's openai-completions
  // client requires a non-null apiKey, so return a placeholder. The proxy
  // replaces the Authorization header before forwarding upstream — what
  // we return here never leaves the host.
  if (providerId === 'clemson' || providerId === 'local') {
    return { apiKey: 'placeholder' };
  }

  // openai-codex: OAuth via auth.json (chatgpt.com — proxy does not handle this).
  if (providerId === 'openai-codex') {
    const credentials = readPiAuthCredentials(providerId, authPath);
    if (credentials) {
      const result = await getOAuthApiKey(providerId, credentials);
      if (!result) return null;
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          ...credentials,
          [providerId]: { type: 'oauth', ...result.newCredentials },
        }, null, 2),
      );
      return { apiKey: result.apiKey };
    }
    return null;
  }

  // Other providers: env var passthrough, then pi-ai's own resolution.
  const placeholderEnv = PLACEHOLDER_ENV_BY_PROVIDER[providerId];
  if (placeholderEnv && process.env[placeholderEnv]) {
    return { apiKey: process.env[placeholderEnv]! };
  }

  const apiKey = getEnvApiKey(providerId);
  return apiKey ? { apiKey } : null;
}
