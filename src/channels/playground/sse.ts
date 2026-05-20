/**
 * Server-Sent Events client tracking for the playground.
 *
 * Each connected browser tab gets one entry in `sseClients`, tagged
 * with the draft folder it cares about and the cookie value of its
 * authenticated session. The cookie tag is what lets per-session
 * revocation (idle expiry, /playground stop --self) close only that
 * session's streams.
 *
 * Self-registers a `auth-store.onSessionRevoked` listener at module
 * load time so revocation transparently reaps SSE clients without
 * the auth-store needing to know about SSE at all.
 */
import http from 'http';

import { onAllSessionsCleared, onSessionRevoked } from './auth-store.js';

interface SseClient {
  draftFolder: string;
  cookieValue: string;
  res: http.ServerResponse;
}

const sseClients = new Set<SseClient>();

/** Push an event to every SSE client subscribed to the given draft. */
export function pushToDraft(draftFolder: string, eventName: string, data: unknown): void {
  for (const client of sseClients) {
    if (client.draftFolder !== draftFolder) continue;
    try {
      client.res.write(`event: ${eventName}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // dropped connection — sweep on next iteration
    }
  }
}

/**
 * Register a new SSE client. Returns a cleanup callback that removes
 * the client from the set — wire it up via `req.on('close', cleanup)`
 * so abrupt disconnects don't leak entries.
 */
export function registerSseClient(opts: {
  draftFolder: string;
  cookieValue: string;
  res: http.ServerResponse;
}): () => void {
  const client: SseClient = opts;
  sseClients.add(client);
  return () => {
    sseClients.delete(client);
  };
}

function closeSseClientsForCookie(cookieValue: string): void {
  for (const client of sseClients) {
    if (client.cookieValue !== cookieValue) continue;
    try {
      client.res.end();
    } catch {
      /* ignore */
    }
    sseClients.delete(client);
  }
}

function closeAllSseClients(): void {
  for (const c of sseClients) {
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
}

// Wire revocation → SSE close. Must run at module-import time so any
// later revoke call (from anywhere in the system) closes the right
// streams.
onSessionRevoked(closeSseClientsForCookie);
onAllSessionsCleared(closeAllSseClients);

/** Test hook — drop everything. */
export function _resetSseForTest(): void {
  sseClients.clear();
}
