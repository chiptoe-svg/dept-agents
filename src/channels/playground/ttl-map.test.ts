import { describe, expect, it } from 'vitest';

import { TtlMap } from './ttl-map.js';

describe('TtlMap', () => {
  it('take returns the value once, then misses', () => {
    const m = new TtlMap<string, number>(60_000);
    m.set('a', 1);
    expect(m.take('a')).toBe(1);
    expect(m.take('a')).toBeUndefined();
  });

  it('take treats expired entries as misses (and removes them)', () => {
    const m = new TtlMap<string, number>(60_000);
    m.set('a', 1, /*ttlMs=*/ -1);
    expect(m.take('a')).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it('sweep drops expired entries and reports the count', () => {
    const m = new TtlMap<string, number>(60_000);
    m.set('alive', 1);
    m.set('dead-1', 2, -1);
    m.set('dead-2', 3, -1);
    expect(m.sweep()).toBe(2);
    expect(m.take('alive')).toBe(1);
  });

  it('clear empties everything', () => {
    const m = new TtlMap<string, number>(60_000);
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('size reflects active entries', () => {
    const m = new TtlMap<string, number>(60_000);
    expect(m.size).toBe(0);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.size).toBe(2);
    m.take('a');
    expect(m.size).toBe(1);
  });
});
