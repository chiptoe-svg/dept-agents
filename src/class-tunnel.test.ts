import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTunnelUrl, startGuestTunnel, stopGuestTunnel } from './class-tunnel.js';

// Spawn-count + handles for the fake cloudflared, shared with the mock
// factory below (vi.hoisted so the hoisted vi.mock call can reference it).
const mockState = vi.hoisted(() => ({ spawnCount: 0 }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // Minimal EventEmitter-shaped stub — enough for class-tunnel's listener
  // wiring (on / once / off / emit) plus a no-op resume().
  function emitter(): Record<string, unknown> {
    const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    const api: Record<string, unknown> = {
      on(ev: string, fn: (...a: unknown[]) => void) {
        const s = listeners.get(ev) ?? new Set();
        listeners.set(ev, s);
        s.add(fn);
        return api;
      },
      once(ev: string, fn: (...a: unknown[]) => void) {
        const wrap = (...a: unknown[]): void => {
          (api.off as (e: string, f: unknown) => void)(ev, wrap);
          fn(...a);
        };
        (wrap as { __orig?: unknown }).__orig = fn;
        return (api.on as (e: string, f: unknown) => unknown)(ev, wrap);
      },
      off(ev: string, fn: (...a: unknown[]) => void) {
        const s = listeners.get(ev);
        if (s) for (const f of [...s]) if (f === fn || (f as { __orig?: unknown }).__orig === fn) s.delete(f);
        return api;
      },
      emit(ev: string, ...a: unknown[]) {
        for (const f of [...(listeners.get(ev) ?? [])]) f(...a);
      },
      resume() {},
    };
    return api;
  }
  return {
    ...actual,
    spawn: () => {
      mockState.spawnCount += 1;
      const proc = emitter();
      proc.stdout = emitter();
      proc.stderr = emitter();
      proc.kill = () => true;
      // Report a tunnel URL once the start-promise has attached its
      // listeners (a macrotask after spawn() returns).
      setTimeout(() => {
        (proc.stderr as { emit: (e: string, ...a: unknown[]) => void }).emit(
          'data',
          Buffer.from('https://test-x.trycloudflare.com'),
        );
      }, 5);
      return proc;
    },
  };
});

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

describe('startGuestTunnel — single-flight', () => {
  afterEach(() => {
    stopGuestTunnel();
    mockState.spawnCount = 0;
  });

  it('two concurrent calls share one spawn and one tunnel', async () => {
    const p1 = startGuestTunnel();
    const p2 = startGuestTunnel();
    // Same in-flight promise — the second caller never reaches spawn().
    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mockState.spawnCount).toBe(1);
    expect(r1).toEqual(r2);
    expect(r1.url).toBe('https://test-x.trycloudflare.com');
  });

  it('a call after the tunnel is live reuses it without spawning again', async () => {
    const first = await startGuestTunnel();
    expect(mockState.spawnCount).toBe(1);
    const again = await startGuestTunnel();
    expect(mockState.spawnCount).toBe(1);
    expect(again.url).toBe(first.url);
  });
});
