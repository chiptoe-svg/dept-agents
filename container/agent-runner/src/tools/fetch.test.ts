import { describe, it, expect, mock } from 'bun:test';
import {
  ipIsBlocked,
  assertUrlAllowed,
  safeFetch,
  defaultPinnedFetch,
  createFetchTool,
} from './fetch.js';
import type { LookupFn, PinnedFetchFn } from './fetch.js';

describe('ipIsBlocked', () => {
  it('blocks loopback, RFC1918, link-local, CGNAT, unspecified', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1',
                       '192.168.64.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(ipIsBlocked(ip)).toBe(true);
    }
  });
  it('blocks IPv6 loopback, ULA, link-local, and IPv4-mapped private', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1']) {
      expect(ipIsBlocked(ip)).toBe(true);
    }
  });
  it('blocks hex-form IPv4-mapped IPv6 for private ranges', () => {
    expect(ipIsBlocked('::ffff:c0a8:1')).toBe(true);   // 192.168.0.1
    expect(ipIsBlocked('::ffff:0a00:0001')).toBe(true); // 10.0.0.1
    expect(ipIsBlocked('::ffff:a00:1')).toBe(true);     // 10.0.0.1 (compressed)
  });
  it('strips IPv6 zone id before checking', () => {
    expect(ipIsBlocked('fe80::1%eth0')).toBe(true);
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) {
      expect(ipIsBlocked(ip)).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(assertUrlAllowed('ftp://x/y')).rejects.toThrow(/scheme/);
  });
  it('rejects IP-literal internal hosts without any DNS lookup', async () => {
    await expect(assertUrlAllowed('http://192.168.64.1:3001/openai/v1/models')).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed('http://127.0.0.1:8888/')).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed('http://169.254.169.254/')).rejects.toThrow(/blocked/);
  });
  it('allows a public IP-literal host', async () => {
    await expect(assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
  });
  it('fails closed when DNS does not resolve (RFC 6761 .invalid never resolves)', async () => {
    await expect(assertUrlAllowed('http://nonexistent.invalid/')).rejects.toThrow(/DNS resolution failed/);
  });
  it('rejects hex IPv4-mapped IPv6 internal address', async () => {
    await expect(assertUrlAllowed('http://[::ffff:c0a8:0001]/')).rejects.toThrow(/blocked/);
  });
  it('rejects a hostname when ANY resolved address is blocked (mixed public + gateway)', async () => {
    const lookup: LookupFn = async () => ['93.184.216.34', '192.168.65.1'];
    await expect(assertUrlAllowed('http://mixed.example/', lookup)).rejects.toThrow(/internal address/);
  });
});

describe('explicit gateway check (env-derived, covers non-RFC1918 gateways)', () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    return fn().finally(() => {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
  }

  it('blocks an exotic non-RFC1918 gateway IP taken from ANTHROPIC_BASE_URL', () =>
    withEnv({ ANTHROPIC_BASE_URL: 'http://198.51.100.9:3001/anthropic', OPENAI_BASE_URL: undefined }, async () => {
      // IP-literal target
      await expect(assertUrlAllowed('http://198.51.100.9/steal')).rejects.toThrow(/gateway|internal/);
      // hostname that resolves to the gateway IP
      const lookup: LookupFn = async () => ['198.51.100.9'];
      await expect(assertUrlAllowed('http://evil.example/', lookup)).rejects.toThrow(/gateway/);
      // an unrelated public IP is still fine
      await expect(assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
    }));

  it('blocks the gateway from OPENAI_BASE_URL too', () =>
    withEnv({ ANTHROPIC_BASE_URL: undefined, OPENAI_BASE_URL: 'http://203.0.113.77:3001/openai/v1' }, async () => {
      const lookup: LookupFn = async () => ['203.0.113.77'];
      await expect(assertUrlAllowed('http://evil.example/', lookup)).rejects.toThrow(/gateway/);
    }));

  it('blocks a non-IP gateway hostname (e.g. host.docker.internal) by name, before DNS', () =>
    withEnv({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:3001', OPENAI_BASE_URL: undefined }, async () => {
      let lookupCalled = false;
      const lookup: LookupFn = async () => {
        lookupCalled = true;
        return ['93.184.216.34'];
      };
      await expect(assertUrlAllowed('http://host.docker.internal:9999/x', lookup)).rejects.toThrow(/container gateway/);
      expect(lookupCalled).toBe(false);
    }));
});

/**
 * DNS-rebinding TOCTOU: the attack is a short-TTL record that resolves to a
 * public IP for the guard's lookup, then to the credential proxy's gateway
 * for the client's own second resolution. The fix pins the vetted IP into
 * the connection so there IS no second resolution.
 *
 * These tests inject the resolver and the pinned transport. Additionally,
 * `globalThis.fetch` is mocked as a "re-resolving client simulator": if the
 * code under test ever regresses to the vulnerable validate-then-fetch(url)
 * pattern, that mock performs the second resolution (returning the gateway,
 * as a rebinding attacker would) and records the IP it would connect to —
 * making the regression observable without any real network.
 */
describe('DNS rebinding pinning (TOCTOU)', () => {
  const PUBLIC_IP = '93.184.216.34';
  const GATEWAY_IP = '192.168.65.1';

  function harness() {
    let lookupCalls = 0;
    const lookup: LookupFn = async () => {
      lookupCalls++;
      return lookupCalls === 1 ? [PUBLIC_IP] : [GATEWAY_IP]; // rebinds after first resolution
    };
    const connections: Array<{ url: string; ip: string }> = [];
    const pinnedFetch: PinnedFetchFn = async (url, ip) => {
      connections.push({ url, ip });
      return new Response('pinned-ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    return { lookup, pinnedFetch, connections, get lookupCalls() { return lookupCalls; } };
  }

  it('connects to the validated IP — a rebound second resolution never reaches the gateway', async () => {
    const h = harness();
    const realFetch = globalThis.fetch;
    // Re-resolving client simulator (see block comment above).
    const clientSim = mock(async (input: unknown) => {
      const host = new URL(String(input)).hostname;
      const ips = await h.lookup(host); // second resolution → gateway
      h.connections.push({ url: String(input), ip: ips[0] });
      return new Response('client-resolved', { status: 200 });
    });
    globalThis.fetch = clientSim as unknown as typeof fetch;
    try {
      const res = await safeFetch('https://rebind.example/secret', {}, {
        lookup: h.lookup,
        pinnedFetch: h.pinnedFetch,
      });
      // THE invariant: no connection ever went to the rebound gateway IP.
      expect(h.connections.map((c) => c.ip)).not.toContain(GATEWAY_IP);
      // The ONLY connection went to the IP that was validated.
      expect(h.connections).toEqual([{ url: 'https://rebind.example/secret', ip: PUBLIC_IP }]);
      expect(await res.text()).toBe('pinned-ok');
      // Resolved exactly once — no second resolution exists to rebind.
      expect(h.lookupCalls).toBe(1);
      expect(clientSim).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('refuses outright when the only resolution is blocked — pin re-checked, no connection attempted', async () => {
    const connections: string[] = [];
    const pinnedFetch: PinnedFetchFn = async (_u, ip) => {
      connections.push(ip);
      return new Response('x');
    };
    await expect(
      safeFetch('http://evil.example/', {}, { lookup: async () => [GATEWAY_IP], pinnedFetch }),
    ).rejects.toThrow(/blocked by egress policy/);
    expect(connections).toEqual([]);
  });

  it('re-pins every redirect hop — a hop that resolves to the gateway is refused', async () => {
    const ipsByHost: Record<string, string> = {
      'hop1.example': PUBLIC_IP,
      'hop2.example': GATEWAY_IP,
    };
    const connections: Array<{ url: string; ip: string }> = [];
    const lookup: LookupFn = async (host) => [ipsByHost[host] ?? '203.0.113.7'];
    const pinnedFetch: PinnedFetchFn = async (url, ip) => {
      connections.push({ url, ip });
      return new Response(null, { status: 302, headers: { location: 'http://hop2.example/creds' } });
    };
    await expect(safeFetch('http://hop1.example/', {}, { lookup, pinnedFetch })).rejects.toThrow(
      /blocked by egress policy/,
    );
    // hop1 was contacted at its pinned IP; hop2 (the gateway) never was.
    expect(connections).toEqual([{ url: 'http://hop1.example/', ip: PUBLIC_IP }]);
  });

  it('each redirect hop gets its own freshly pinned IP (hop-1 pin is not reused)', async () => {
    const ipsByHost: Record<string, string> = {
      'hop1.example': PUBLIC_IP,
      'hop2.example': '203.0.113.7',
    };
    const connections: Array<{ url: string; ip: string }> = [];
    const lookup: LookupFn = async (host) => [ipsByHost[host]];
    const pinnedFetch: PinnedFetchFn = async (url, ip) => {
      connections.push({ url, ip });
      if (url.includes('hop1')) {
        return new Response(null, { status: 302, headers: { location: 'http://hop2.example/final' } });
      }
      return new Response('final', { status: 200 });
    };
    const res = await safeFetch('http://hop1.example/', {}, { lookup, pinnedFetch });
    expect(await res.text()).toBe('final');
    expect(connections).toEqual([
      { url: 'http://hop1.example/', ip: PUBLIC_IP },
      { url: 'http://hop2.example/final', ip: '203.0.113.7' },
    ]);
  });

  it('defaultPinnedFetch refuses a blocked pinned address at connect time (belt-and-braces; also proves the runtime honors the lookup hook)', async () => {
    // Uses a .invalid hostname: nothing is ever connectable, and if the
    // runtime IGNORED our lookup hook it would fail with a DNS error rather
    // than this exact egress-policy message — so this doubles as a canary
    // that the pin is actually wired into the socket layer.
    await expect(
      defaultPinnedFetch('http://pin-guard.invalid/', GATEWAY_IP, {}),
    ).rejects.toThrow(/pinned address 192\.168\.65\.1 refused at connect time/);
    await expect(
      defaultPinnedFetch('http://pin-guard.invalid/', '127.0.0.1', {}),
    ).rejects.toThrow(/refused at connect time/);
  });
});

describe('fetch_url redirect re-validation', () => {
  const publicLookup: LookupFn = async () => ['93.184.216.34'];

  it('blocks a redirect that points at an internal IP', async () => {
    const pinnedFetch: PinnedFetchFn = async () =>
      new Response(null, { status: 302, headers: { location: 'http://192.168.64.1:3001/openai/v1/models' } });
    const tool = createFetchTool({ lookup: publicLookup, pinnedFetch });
    const res = await tool.execute('id', { url: 'https://example.com/redirect' });
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toMatch(/blocked by egress policy/);
  });

  it('follows a redirect to a public URL and returns the body', async () => {
    let callCount = 0;
    const pinnedFetch: PinnedFetchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/final' } });
      }
      return new Response('hello from final', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const tool = createFetchTool({ lookup: publicLookup, pinnedFetch });
    const res = await tool.execute('id', { url: 'https://example.com/start' });
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toBe('hello from final');
  });

  it('caps redirect chains', async () => {
    const pinnedFetch: PinnedFetchFn = async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } });
    const tool = createFetchTool({ lookup: publicLookup, pinnedFetch });
    const res = await tool.execute('id', { url: 'https://example.com/start' });
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toMatch(/too many redirects/);
  });
});
