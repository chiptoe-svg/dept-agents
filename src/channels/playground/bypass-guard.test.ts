/**
 * Bypass startup-guard predicate (Plan 3 final-review Fix 4).
 *
 * Production binds 127.0.0.1:3002 behind Caddy :8088, so the old
 * "non-loopback bind" guard never fired there — one .env edit
 * (PLAYGROUND_AUTH_BYPASS / BENCH_MODE) re-exposed owner authority to the
 * public proxy. The guard must now also refuse when PUBLIC_PLAYGROUND_URL
 * points at a non-localhost address, without breaking plain local dev.
 */
import { describe, expect, it } from 'vitest';

import { bypassRefusalReason, isRemotePublicUrl } from './bypass-guard.js';

const REMOTE_URL = 'http://198.51.100.7:8088';

describe('isRemotePublicUrl', () => {
  it('false when unset (plain local dev)', () => {
    expect(isRemotePublicUrl(undefined)).toBe(false);
    expect(isRemotePublicUrl('')).toBe(false);
  });

  it('false for localhost variants', () => {
    expect(isRemotePublicUrl('http://localhost:3002')).toBe(false);
    expect(isRemotePublicUrl('http://127.0.0.1:8088')).toBe(false);
    expect(isRemotePublicUrl('http://[::1]:3002')).toBe(false);
  });

  it('true for public IPs and hostnames', () => {
    expect(isRemotePublicUrl(REMOTE_URL)).toBe(true);
    expect(isRemotePublicUrl('https://playground.example.edu')).toBe(true);
  });

  it('true (fail closed) for set-but-unparsable values', () => {
    expect(isRemotePublicUrl('not a url')).toBe(true);
  });
});

describe('bypassRefusalReason', () => {
  const base = { authBypass: false, benchMode: false, bindHost: '127.0.0.1', publicPlaygroundUrl: undefined };

  it('allows startup when no bypass mode is on, regardless of exposure', () => {
    expect(bypassRefusalReason({ ...base, bindHost: '0.0.0.0', publicPlaygroundUrl: REMOTE_URL })).toBeNull();
  });

  it('allows bypass on loopback with no public URL (local dev)', () => {
    expect(bypassRefusalReason({ ...base, authBypass: true })).toBeNull();
    expect(bypassRefusalReason({ ...base, benchMode: true })).toBeNull();
  });

  it('allows bypass on loopback with a localhost public URL (local dev behind local proxy)', () => {
    expect(bypassRefusalReason({ ...base, authBypass: true, publicPlaygroundUrl: 'http://localhost:8088' })).toBeNull();
  });

  it('refuses bypass on a non-loopback bind (original guard preserved)', () => {
    const reason = bypassRefusalReason({ ...base, authBypass: true, bindHost: '0.0.0.0' });
    expect(reason).toContain('PLAYGROUND_AUTH_BYPASS');
    expect(reason).toContain('non-loopback');
  });

  it('refuses bypass on loopback when PUBLIC_PLAYGROUND_URL is remote (proxied box)', () => {
    const reason = bypassRefusalReason({ ...base, authBypass: true, publicPlaygroundUrl: REMOTE_URL });
    expect(reason).toContain('PLAYGROUND_AUTH_BYPASS');
    expect(reason).toContain('PUBLIC_PLAYGROUND_URL');
    expect(reason).toContain('reverse proxy');
  });

  it('refuses BENCH_MODE the same way, naming the right toggle', () => {
    const reason = bypassRefusalReason({ ...base, benchMode: true, publicPlaygroundUrl: REMOTE_URL });
    expect(reason).toContain('BENCH_MODE');
    expect(reason).not.toContain('PLAYGROUND_AUTH_BYPASS is enabled');
  });

  it('refuses when the public URL is set but unparsable (fail closed)', () => {
    expect(bypassRefusalReason({ ...base, authBypass: true, publicPlaygroundUrl: 'not a url' })).not.toBeNull();
  });
});
