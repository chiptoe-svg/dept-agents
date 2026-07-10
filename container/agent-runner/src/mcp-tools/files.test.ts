/**
 * Tests for fetch_url_to_workspace's SSRF guard and happy-path behavior.
 *
 * The guard itself (`assertUrlAllowed` / `ipIsBlocked`) lives in
 * `../tools/fetch.ts` and has its own direct unit tests there. These tests
 * exercise it end-to-end through the MCP tool handler — the thing an agent
 * actually calls — plus the redirect re-validation loop and the DNS
 * resolved-IP check that are specific to how this tool drives the fetch.
 *
 * No real network requests are made: the "happy path" / redirect tests
 * mock `globalThis.fetch`, and the SSRF-refusal tests never reach `fetch`
 * at all (assertUrlAllowed throws before any request is made).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { fetchUrlToWorkspace } from './files.js';

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-url-to-workspace-test-'));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function content(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe('fetch_url_to_workspace — SSRF guard refusals', () => {
  it('refuses the bridge gateway (192.168.65.1 — current Apple Container 1.1.0 subnet)', async () => {
    const r = await fetchUrlToWorkspace.handler({
      url: 'http://192.168.65.1:3001/anthropic',
      filename: path.join(scratch, 'x'),
    });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses the bridge gateway on the old subnet too (192.168.64.1) — structural CIDR block, not a hardcoded IP', async () => {
    const r = await fetchUrlToWorkspace.handler({
      url: 'http://192.168.64.1:3001/anthropic',
      filename: path.join(scratch, 'x'),
    });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses loopback 127.0.0.0/8', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://127.0.0.1:8888/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses IPv6 loopback ::1', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://[::1]/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses 0.0.0.0 (unspecified)', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://0.0.0.0/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses link-local 169.254.0.0/16 (cloud metadata range)', async () => {
    const r = await fetchUrlToWorkspace.handler({
      url: 'http://169.254.169.254/latest/meta-data',
      filename: path.join(scratch, 'x'),
    });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses IPv6 link-local fe80::/10', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://[fe80::1]/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses RFC1918 10.0.0.0/8', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://10.0.0.5/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses RFC1918 172.16.0.0/12', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://172.20.0.5/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses RFC1918 192.168.0.0/16', async () => {
    const r = await fetchUrlToWorkspace.handler({ url: 'http://192.168.1.5/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });

  it('refuses non-http(s) schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/y', 'ftp://x/y', 'data:text/plain;base64,aGVsbG8=']) {
      const r = await fetchUrlToWorkspace.handler({ url, filename: path.join(scratch, 'x') });
      expect(r.isError).toBe(true);
    }
  });

  it('does not write any file when the target is blocked', async () => {
    const target = path.join(scratch, 'should-not-exist.bin');
    const r = await fetchUrlToWorkspace.handler({ url: 'http://192.168.65.1:3001/', filename: target });
    expect(r.isError).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('fetch_url_to_workspace — DNS resolved-IP validation (rebinding)', () => {
  it('refuses "localhost" even though the literal string is not an IP — it resolves to 127.0.0.1/::1', async () => {
    // No mocking here on purpose: "localhost" resolves via the OS
    // hosts file, not the network, so this is offline-safe and proves
    // the guard checks the RESOLVED address, not a hostname string match.
    // A guard that only string-matched hostnames (like the personal
    // repo's allowlist-of-two-hostnames approach) would never catch this.
    const r = await fetchUrlToWorkspace.handler({ url: 'http://localhost:9999/', filename: path.join(scratch, 'x') });
    expect(r.isError).toBe(true);
    expect(content(r)).toMatch(/blocked/);
  });
});

describe('fetch_url_to_workspace — happy path (mocked network)', () => {
  it('saves an ordinary public https URL response to the workspace', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'out.txt');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/file.txt', filename: target });
      expect(r.isError).toBeFalsy();
      expect(content(r)).toContain('Saved');
      expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('creates missing parent directories', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('data', { status: 200 })) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'nested', 'dir', 'out.bin');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/file.bin', filename: target });
      expect(r.isError).toBeFalsy();
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns an error for a non-2xx response without writing a file', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'missing.txt');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/missing', filename: target });
      expect(r.isError).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('fetch_url_to_workspace — redirect re-validation', () => {
  it('follows a redirect to a public URL and saves the final body', async () => {
    const realFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/final' } });
      }
      return new Response('final body', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'redirected.txt');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/start', filename: target });
      expect(r.isError).toBeFalsy();
      expect(fs.readFileSync(target, 'utf-8')).toBe('final body');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('blocks a redirect that points at the bridge gateway — a one-shot check on the original URL would miss this', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response(null, { status: 302, headers: { location: 'http://192.168.65.1:3001/openai/v1/models' } }),
    ) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'blocked.txt');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/redirect', filename: target });
      expect(r.isError).toBe(true);
      expect(content(r)).toMatch(/blocked/);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('caps redirect chains', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () => new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    ) as unknown as typeof fetch;
    try {
      const target = path.join(scratch, 'loop.txt');
      const r = await fetchUrlToWorkspace.handler({ url: 'https://example.com/start', filename: target });
      expect(r.isError).toBe(true);
      expect(content(r)).toMatch(/too many redirects/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
