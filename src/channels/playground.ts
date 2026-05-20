/**
 * Playground channel — local web workbench for iterating on agent
 * personas before applying them to a target group.
 *
 * Architecture:
 *   - Registers as a normal channel adapter (`channel_type = 'playground'`).
 *   - Each draft gets its own auto-created `messaging_groups` row via
 *     `ensureDraftMessagingGroup` from agent-builder/core.ts.
 *   - HTTP server is *lazy*: not bound at host boot. `/playground` on
 *     Telegram calls `startPlaygroundServer()` which binds the port.
 *     `/playground stop` calls `stopPlaygroundServer()`.
 *
 * This file is intentionally thin — it's a barrel + a side-effect
 * import that triggers `playground/adapter.ts` and `playground/sse.ts`
 * (the latter wires its revoke listener into auth-store at module
 * load). The real surface lives in:
 *
 *   - `playground/auth-store.ts`   session store, magic tokens, idle sweep
 *   - `playground/sse.ts`          SSE client tracking + auto-revoke wiring
 *   - `playground/adapter.ts`      channel-registry adapter + setupConfig
 *   - `playground/server.ts`       HTTP server lifecycle + request dispatch
 *   - `playground/api-routes.ts`   the REST + SSE endpoints
 *   - `playground/google-oauth.ts` Google OAuth login flow
 *   - `playground/http-helpers.ts` shared `send` / `readJsonBody` / etc.
 *   - `playground/ttl-map.ts`      TTL'd Map primitive
 */

// Side-effect imports: register the channel adapter and wire SSE
// auto-close-on-revoke. Order matters only loosely — sse.ts must have
// its hooks installed before any session is revoked, which is always
// the case on a fresh process.
import './playground/adapter.js';
import './playground/sse.js';

// Re-exports — the public surface other modules (telegram.ts, smoke
// scripts, google-oauth.ts) consume. Keep the list explicit so
// removals show up in usages rather than disappearing silently.
export {
  COOKIE_NAME,
  type PlaygroundSession,
  createSessionFromMagicToken,
  formatSessionCookie,
  mintMagicToken,
  mintSessionForUser,
  revokeSession,
  revokeSessionsForUser,
  sweepIdleSessions,
  // Test hooks
  _hasSessionForTest,
  _resetSessionsForTest,
  _sessionCountForTest,
  _setSessionActivityForTest,
} from './playground/auth-store.js';

export { getPlaygroundStatus, startPlaygroundServer, stopPlaygroundServer } from './playground/server.js';
