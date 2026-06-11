import { describe, it, expect, mock } from 'bun:test';
import { ipIsBlocked, assertUrlAllowed } from './fetch.js';

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
});

describe('fetch_url redirect re-validation', () => {
  it('blocks a redirect that points at an internal IP', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(null, { status: 302, headers: { location: 'http://192.168.64.1:3001/openai/v1/models' } }),
    ) as unknown as typeof fetch;
    try {
      const { createFetchTool } = await import('./fetch.js');
      const tool = createFetchTool();
      const res = await tool.execute('id', { url: 'https://example.com/redirect' });
      const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
      expect(text).toMatch(/blocked by egress policy/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
