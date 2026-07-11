/**
 * Pure predicate for the playground's auth-bypass startup guard.
 *
 * PLAYGROUND_AUTH_BYPASS and BENCH_MODE mint an owner session for any
 * caller, so they must never be reachable from the network. The original
 * guard only refused non-loopback binds — but production binds
 * 127.0.0.1:3002 behind a reverse proxy (Caddy :8088), where a loopback
 * bind is still publicly reachable and one .env edit re-exposes owner
 * authority. So the guard also refuses when PUBLIC_PLAYGROUND_URL points
 * at a non-localhost address: that env var existing with a remote host is
 * the signal that this box is publicly proxied.
 *
 * Extracted from server.ts as a pure function so the refusal logic is
 * unit-testable without booting the HTTP server.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/**
 * True when `publicUrl` is set and points at anything other than a
 * localhost address. Unset → false (plain local dev). Set-but-unparsable
 * → true (fail closed: we can't prove it's local).
 */
export function isRemotePublicUrl(publicUrl: string | undefined): boolean {
  if (!publicUrl) return false;
  try {
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '');
    return !LOOPBACK_HOSTS.has(host);
  } catch {
    return true;
  }
}

export interface BypassGuardInput {
  authBypass: boolean;
  benchMode: boolean;
  bindHost: string;
  publicPlaygroundUrl: string | undefined;
}

/**
 * Returns null when starting is safe, else a human-readable reason the
 * server must refuse to start. Local dev (loopback bind, localhost or
 * unset PUBLIC_PLAYGROUND_URL) stays allowed.
 */
export function bypassRefusalReason(input: BypassGuardInput): string | null {
  if (!input.authBypass && !input.benchMode) return null;
  const mode = input.authBypass ? 'PLAYGROUND_AUTH_BYPASS' : 'BENCH_MODE';
  if (!LOOPBACK_HOSTS.has(input.bindHost)) {
    return (
      `${mode} is enabled while PLAYGROUND_BIND_HOST=${input.bindHost} (non-loopback). A bypass mode mints ` +
      `an owner session for every request — it must only run on 127.0.0.1. Set the bind host to 127.0.0.1, ` +
      `or disable the bypass before exposing the playground.`
    );
  }
  if (isRemotePublicUrl(input.publicPlaygroundUrl)) {
    return (
      `${mode} is enabled while PUBLIC_PLAYGROUND_URL=${input.publicPlaygroundUrl} points at a non-localhost ` +
      `address — the loopback bind is publicly reachable through a reverse proxy, so a bypass mode would mint ` +
      `an owner session for any external caller. Disable the bypass, or unset/localhost PUBLIC_PLAYGROUND_URL ` +
      `for local development.`
    );
  }
  return null;
}
