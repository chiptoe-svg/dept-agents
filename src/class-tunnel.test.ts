import { describe, expect, it } from 'vitest';

import { parseTunnelUrl } from './class-tunnel.js';

describe('parseTunnelUrl', () => {
  it('extracts a trycloudflare URL from a cloudflared log line', () => {
    const line = '2026-05-20T18:00:00Z INF |  https://random-words-here.trycloudflare.com  |';
    expect(parseTunnelUrl(line)).toBe('https://random-words-here.trycloudflare.com');
  });

  it('returns null when no URL is present', () => {
    expect(parseTunnelUrl('2026-05-20 INF Requesting new quick tunnel on trycloudflare.com...')).toBeNull();
  });

  it('ignores non-trycloudflare https URLs', () => {
    expect(parseTunnelUrl('see https://example.com/docs for details')).toBeNull();
  });

  it('returns the first match across a multiline chunk', () => {
    const chunk = 'noise\nhttps://abc-def.trycloudflare.com\nhttps://xyz.trycloudflare.com\n';
    expect(parseTunnelUrl(chunk)).toBe('https://abc-def.trycloudflare.com');
  });
});
