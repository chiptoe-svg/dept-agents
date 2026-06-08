/**
 * Codex CLI auth.json bridge — translates between per-student creds
 * (`user-provider-auth.ts` shape) and the on-disk auth.json that pi-ai's
 * openai-codex provider reads from `/workspace/.pi-auth/auth.json`.
 *
 * Two directions:
 *
 *   userCredsToCodexAuthJson  — at session-spawn time, write a per-student
 *                                  auth.json into the session's pi-auth dir
 *                                  so the container's pi-ai sees the student's
 *                                  ChatGPT tokens (not the owner's).
 *
 *   extractRefreshedFromAuthJson — after a container exits (or before the
 *                                  next spawn overwrites the file), read the
 *                                  refreshed tokens pi wrote back. Pi's
 *                                  refresh writeback shape is `{...orig,
 *                                  'openai-codex': { type:'oauth', access,
 *                                  refresh, expires, ... }}` — see
 *                                  container/agent-runner/src/providers/pi-auth.ts.
 *
 * id_token + account_id are passed through verbatim when present but are NOT
 * required — adaptForeignAuth() in pi-auth.ts only needs access_token +
 * refresh_token. The playground OAuth flow does not capture id_token
 * (see provider-auth.ts), so initial student auth.jsons omit it; pi
 * tolerates that.
 */
import type { UserProviderCreds } from './user-provider-auth.js';

/**
 * Translate a per-student creds record into the codex CLI auth.json shape
 * pi-ai reads. Returns null when the student has no codex OAuth tokens
 * (the openai-codex path requires ChatGPT subscription OAuth — an
 * openai-platform API key cannot be used here because chatgpt.com is not
 * an API-key endpoint).
 */
export function userCredsToCodexAuthJson(creds: UserProviderCreds | null): Record<string, unknown> | null {
  if (!creds?.oauth) return null;
  if (creds.active !== 'oauth') return null;
  return {
    OPENAI_API_KEY: null,
    tokens: {
      access_token: creds.oauth.accessToken,
      refresh_token: creds.oauth.refreshToken,
    },
    last_refresh: new Date(creds.oauth.addedAt).toISOString(),
  };
}

/**
 * Read the post-refresh tokens pi wrote to auth.json. Two layouts:
 *
 *   {                                    initial (codex CLI format)
 *     tokens: { access_token, refresh_token, ... }
 *   }
 *
 *   {                                    after pi refresh
 *     ...originalCredsObject,
 *     "openai-codex": { type: "oauth", access, refresh, expires, ... }
 *   }
 *
 * Prefer the `openai-codex` key when present — it's the post-refresh form
 * and reflects the freshest tokens. Falls back to the codex CLI `tokens`
 * block. Returns null if neither yields a usable refresh token.
 */
export function extractRefreshedFromAuthJson(
  raw: unknown,
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  if (!raw || typeof raw !== 'object') return null;

  const piShape = (raw as Record<string, unknown>)['openai-codex'];
  if (piShape && typeof piShape === 'object') {
    const p = piShape as { access?: string; refresh?: string; expires?: number };
    if (typeof p.access === 'string' && typeof p.refresh === 'string') {
      return {
        accessToken: p.access,
        refreshToken: p.refresh,
        expiresAt: typeof p.expires === 'number' ? p.expires : Date.now() + 55 * 60 * 1000,
      };
    }
  }

  const codexShape = (raw as { tokens?: { access_token?: string; refresh_token?: string } }).tokens;
  if (codexShape?.access_token && codexShape.refresh_token) {
    // codex CLI format has no expiry field; defer to caller (refresh-buffer
    // heuristic in the resolver). Use Date.now() so callers see "expires
    // ~now" and pi-ai's first request triggers a refresh — which then
    // writes the freshest tokens back via the openai-codex key above.
    return {
      accessToken: codexShape.access_token,
      refreshToken: codexShape.refresh_token,
      expiresAt: Date.now(),
    };
  }

  return null;
}
