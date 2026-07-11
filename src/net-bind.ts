/**
 * Bind an HTTP handler to loopback + the container bridge gateway — never a
 * wildcard. Credential-bearing local services (credential proxy, GWS relay)
 * must be reachable by host direct-chat (loopback) and by containers (the
 * bridge gateway) but NOT by the campus LAN. Binding 0.0.0.0 would expose
 * real API keys / OAuth tokens to anything that can route to the host IP.
 *
 * The loopback server binds immediately (always available; preserves the
 * proxy's loopback-trust path). The gateway server binds with retry because
 * on Apple Container the bridge interface (bridge100 / 192.168.65.1) may not
 * exist until the first container starts — and the proxy starts first. No
 * container can reach gateway:port before the bridge exists, so retrying the
 * bind until it succeeds has no correctness gap.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo, isIP } from 'net';

import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { log } from './log.js';

/** The only hosts the loopback bind is allowed to use verbatim. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

/**
 * True if `host` denotes an all-interfaces / all-zero address in any common
 * spelling (IPv4 `0.0.0.0`, IPv6 `::`, `::0`, `0:0:0:0:0:0:0:0`, the
 * IPv4-mapped `::ffff:0.0.0.0`, or the empty string). Used to refuse binding
 * the gateway server to a wildcard.
 */
export function isWildcardAddress(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed === '') return true;
  const family = isIP(trimmed);
  if (family === 4) {
    return trimmed.split('.').every((octet) => Number(octet) === 0);
  }
  if (family === 6) {
    const lower = trimmed.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return mapped[1].split('.').every((octet) => Number(octet) === 0);
    }
    const stripped = lower.replace(/:/g, '');
    return stripped === '' || /^0+$/.test(stripped);
  }
  return false;
}

export interface DualBindHandle {
  /** Bound servers: loopback always; gateway appended once the bridge is up. */
  servers: Server[];
  /** Idempotently close every bound server and cancel any pending retry. */
  close(): void;
}

export interface DualBindOptions {
  loopbackHost?: string;
  resolveGateway?: () => string;
  retryMs?: number;
  label?: string;
}

export function listenLoopbackAndGateway(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port: number,
  opts: DualBindOptions = {},
): Promise<DualBindHandle> {
  const label = opts.label ?? 'service';
  const retryMs = opts.retryMs ?? 2000;
  const resolveGateway = opts.resolveGateway ?? CONTAINER_HOST_GATEWAY;

  let loopbackHost = opts.loopbackHost ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(loopbackHost.trim())) {
    // Covers both wildcards (0.0.0.0, ::, '') and any other non-loopback
    // address (LAN/campus IP, a stale gateway value, etc.) — none of these
    // may ever back the loopback listener.
    log.warn(`Refusing to bind ${label} to a non-loopback bind address; using 127.0.0.1`, {
      requested: loopbackHost,
    });
    loopbackHost = '127.0.0.1';
  }

  const servers: Server[] = [];
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const handle: DualBindHandle = {
    servers,
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      for (const s of servers) {
        try {
          s.close();
        } catch {
          // best-effort
        }
      }
    },
  };

  return new Promise((resolve, reject) => {
    const loopback = createServer(handler);
    let loopbackListening = false;
    loopback.on('error', (err) => {
      // Reject only while we're still trying to come up; once listening, a
      // later runtime error must be logged, not silently swallowed by an
      // already-settled promise.
      if (loopbackListening) {
        log.error(`${label}: loopback server error`, { err: String(err) });
      } else {
        reject(err);
      }
    });
    loopback.listen(port, loopbackHost, () => {
      loopbackListening = true;
      servers.push(loopback);
      const boundPort = (loopback.address() as AddressInfo).port;
      log.info(`${label} listening`, { host: loopbackHost, port: boundPort });

      // Now bring up the gateway server on the SAME port, with retry.
      const bindGateway = () => {
        if (closed) return;
        let gateway: string;
        try {
          gateway = resolveGateway();
        } catch (err) {
          log.debug(`${label}: gateway not resolvable yet, will retry`, { err: String(err) });
          retryTimer = setTimeout(bindGateway, retryMs);
          return;
        }
        if (gateway === loopbackHost) {
          log.debug(`${label}: gateway equals loopback, no second bind needed`, { gateway });
          return;
        }
        if (isWildcardAddress(gateway)) {
          log.warn(`Refusing to bind ${label} to a wildcard address; will retry`, {
            requested: gateway,
          });
          if (!closed) retryTimer = setTimeout(bindGateway, retryMs);
          return;
        }
        const gwServer = createServer(handler);
        gwServer.once('error', (err: NodeJS.ErrnoException) => {
          log.debug(`${label}: gateway bind failed, will retry`, { gateway, code: err.code });
          try {
            gwServer.close();
          } catch {
            // best-effort
          }
          if (!closed) retryTimer = setTimeout(bindGateway, retryMs);
        });
        gwServer.listen(boundPort, gateway, () => {
          // close() may have raced the in-flight listen(); if so, this server
          // isn't in `servers` yet, so nothing would ever close it. Close it
          // here and don't push a bound-but-orphaned server (leaked port).
          if (closed) {
            try {
              gwServer.close();
            } catch {
              // best-effort
            }
            return;
          }
          servers.push(gwServer);
          log.info(`${label} listening`, { host: gateway, port: boundPort });
        });
      };
      bindGateway();

      resolve(handle);
    });
  });
}
