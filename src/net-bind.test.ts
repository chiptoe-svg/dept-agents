import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, get as httpGet, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { listenLoopbackAndGateway, DualBindHandle } from './net-bind.js';

// Mock the default gateway resolver so tests never touch a real bridge.
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: () => '::1',
}));

const handles: DualBindHandle[] = [];
afterEach(() => {
  for (const h of handles) h.close();
  handles.length = 0;
});

const okHandler = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200);
  res.end('ok');
};

/** Resolve the port a given server bound to. */
function portOf(h: DualBindHandle, host: string): number {
  const s = h.servers.find((srv) => (srv.address() as AddressInfo)?.address === host);
  if (!s) throw new Error(`no server bound to ${host}`);
  return (s.address() as AddressInfo).port;
}

/** True if an HTTP GET to host:port returns 200 within the timeout. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host, port, timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

describe('listenLoopbackAndGateway', () => {
  it('binds loopback and the gateway, but not a third address', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      resolveGateway: () => '::1',
      retryMs: 20,
    });
    handles.push(h);
    // Both binds share the SAME port (port 0 picks one; gateway reuses it).
    // Wait briefly for the async gateway bind.
    await new Promise((r) => setTimeout(r, 100));
    const port = portOf(h, '127.0.0.1');
    expect(await reachable('127.0.0.1', port)).toBe(true);
    expect(await reachable('::1', port)).toBe(true);
    // A loopback address we did NOT bind must be unreachable.
    expect(await reachable('127.0.0.3', port)).toBe(false);
  });

  it('coerces a wildcard loopbackHost to 127.0.0.1 and never binds 0.0.0.0', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      loopbackHost: '0.0.0.0',
      resolveGateway: () => '::1',
      retryMs: 20,
    });
    handles.push(h);
    // No server may be bound to the wildcard address.
    const boundAddrs = h.servers.map((s) => (s.address() as AddressInfo).address);
    expect(boundAddrs).not.toContain('0.0.0.0');
    expect(boundAddrs).toContain('127.0.0.1');
  });

  it('retries the gateway bind until the address becomes available', async () => {
    let attempts = 0;
    // First two resolves throw (simulating bridge-not-up), third returns a real addr.
    const resolveGateway = () => {
      attempts += 1;
      if (attempts < 3) throw new Error('bridge not up yet');
      return '::1';
    };
    const h = await listenLoopbackAndGateway(okHandler, 0, { resolveGateway, retryMs: 20 });
    handles.push(h);
    // Loopback is up immediately even though the gateway is not.
    const port = portOf(h, '127.0.0.1');
    expect(await reachable('127.0.0.1', port)).toBe(true);
    // After enough retry cycles the gateway binds too.
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(await reachable('::1', port)).toBe(true);
  });

  it('skips the second bind when the gateway equals loopback', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      loopbackHost: '127.0.0.1',
      resolveGateway: () => '127.0.0.1',
      retryMs: 20,
    });
    handles.push(h);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.servers).toHaveLength(1);
  });

  it('never binds a wildcard even when the gateway resolves to one', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      resolveGateway: () => '0.0.0.0',
      retryMs: 20,
    });
    handles.push(h);
    // Give the async gateway attempt a beat to (refuse to) run.
    await new Promise((r) => setTimeout(r, 80));
    const boundAddrs = h.servers.map((s) => (s.address() as AddressInfo)?.address);
    expect(boundAddrs).not.toContain('0.0.0.0');
    expect(boundAddrs).toContain('127.0.0.1');
  });

  it('does not leak a gateway server when close() races the in-flight listen', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      resolveGateway: () => '::1',
      retryMs: 20,
    });
    const port = portOf(h, '127.0.0.1');
    // Close immediately, before the gateway bind can settle.
    h.close();
    await new Promise((r) => setTimeout(r, 100));
    // No open server may remain: every entry has a null address(), and the
    // loopback port is no longer reachable.
    for (const s of h.servers) {
      expect(s.address()).toBeNull();
    }
    expect(await reachable('127.0.0.1', port)).toBe(false);
    expect(await reachable('::1', port)).toBe(false);
  });
});
