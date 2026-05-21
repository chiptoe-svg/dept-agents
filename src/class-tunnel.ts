/**
 * Guest tunnel — an ephemeral cloudflared quick tunnel that exposes the
 * local playground port over public HTTPS so an off-campus feedback
 * guest can reach it.
 *
 * Quick tunnels need no Cloudflare account and no DNS: cloudflared prints
 * a random `https://<sub>.trycloudflare.com` URL and proxies it to the
 * local port over an outbound-only connection (campus-firewall friendly).
 *
 * One tunnel at a time, host-process-scoped. It self-terminates after 60
 * minutes; a host restart also kills it. Started on demand by the
 * playground "Add Student → external guest" flow.
 *
 * SECURITY: while live, the tunnel publicly exposes the whole playground
 * port. That is only safe because every non-public route requires the
 * session cookie — the login page and token-consumption endpoint are the
 * sole unauthenticated surface. Anything that widens that surface — in
 * particular `BENCH_MODE=1`, which bypasses playground auth in
 * `server.ts` — must NOT be combined with a live guest tunnel.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';

import { PLAYGROUND_PORT } from './config.js';
import { log } from './log.js';

const TUNNEL_TTL_MS = 60 * 60 * 1000; // 60 minutes
const URL_WAIT_MS = 30_000;

export interface GuestTunnelInfo {
  url: string;
  startedAt: number;
  expiresAt: number;
}

interface TunnelState extends GuestTunnelInfo {
  proc: ChildProcess;
  killTimer: NodeJS.Timeout;
}

let current: TunnelState | null = null;

// In-flight start. cloudflared takes up to 30s to report its URL and
// `current` isn't assigned until then, so a second concurrent call (a
// double-click on "Add Student → external") would clear the `current`
// guard and spawn a second, orphaned `cloudflared`. Concurrent callers
// share this Promise instead; it is cleared once the start settles.
let starting: Promise<GuestTunnelInfo> | null = null;

/** Extract the first `https://<sub>.trycloudflare.com` URL from a log chunk. */
export function parseTunnelUrl(chunk: string): string | null {
  const m = chunk.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/** Resolve the cloudflared binary — Homebrew paths first, then PATH. */
function cloudflaredBin(): string {
  for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
    if (fs.existsSync(p)) return p;
  }
  return 'cloudflared';
}

export function getGuestTunnel(): GuestTunnelInfo | null {
  if (!current) return null;
  return { url: current.url, startedAt: current.startedAt, expiresAt: current.expiresAt };
}

export function stopGuestTunnel(): boolean {
  if (!current) return false;
  clearTimeout(current.killTimer);
  const { proc } = current;
  current = null;
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  log.info('Guest tunnel stopped');
  return true;
}

/**
 * Start (or reuse) a cloudflared quick tunnel for the playground port.
 * Self-terminates after 60 minutes. Only one tunnel runs at a time — a
 * caller arriving while one is live, or while one is still starting,
 * gets that same tunnel back rather than spawning a second process.
 */
export function startGuestTunnel(): Promise<GuestTunnelInfo> {
  if (current) return Promise.resolve(getGuestTunnel()!);
  if (starting) return starting;
  starting = spawnGuestTunnel();
  // Clear the in-flight slot once the start settles: on success `current`
  // is set so the guard above takes over; on failure the next call retries.
  // The success/failure handlers also mark `starting` as handled so its
  // rejection (still surfaced to the caller) is not an unhandled rejection.
  starting.then(
    () => {
      starting = null;
    },
    () => {
      starting = null;
    },
  );
  return starting;
}

async function spawnGuestTunnel(): Promise<GuestTunnelInfo> {
  // spawn() with an explicit argv array — no shell, no interpolation.
  const proc = spawn(cloudflaredBin(), ['tunnel', '--url', `http://localhost:${PLAYGROUND_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error(`cloudflared did not report a tunnel URL within ${URL_WAIT_MS / 1000}s`));
    }, URL_WAIT_MS);

    const onChunk = (buf: Buffer): void => {
      const found = parseTunnelUrl(buf.toString());
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`cloudflared exited (code ${code}) before reporting a URL`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off('data', onChunk);
      proc.stderr?.off('data', onChunk);
      proc.off('error', onError);
      proc.off('exit', onExit);
    }

    // cloudflared prints the assigned URL to stderr; watch both streams.
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.once('error', onError);
    proc.once('exit', onExit);
  });

  // Drain the streams for the rest of the tunnel's life so cloudflared's
  // ongoing log writes never block on a full pipe.
  proc.stdout?.resume();
  proc.stderr?.resume();

  const startedAt = Date.now();
  const expiresAt = startedAt + TUNNEL_TTL_MS;
  const killTimer = setTimeout(() => {
    log.info('Guest tunnel expired after 60 min');
    stopGuestTunnel();
  }, TUNNEL_TTL_MS);
  killTimer.unref?.();

  // If cloudflared dies on its own, drop our state so a later start works.
  proc.once('exit', () => {
    if (current && current.proc === proc) {
      clearTimeout(current.killTimer);
      current = null;
      log.warn('Guest tunnel process exited unexpectedly');
    }
  });

  current = { url, startedAt, expiresAt, proc, killTimer };
  log.info('Guest tunnel started', { url, expiresAt: new Date(expiresAt).toISOString() });
  return { url, startedAt, expiresAt };
}
