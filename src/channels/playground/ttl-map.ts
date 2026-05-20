/**
 * Bounded-by-TTL map. Same shape as a Map<K, V> but every entry has an
 * expiry; reads past expiry behave like misses, and `sweep()` drops
 * expired entries in O(n).
 *
 * Used by:
 *   - `auth-store.ts` for `pendingMagicTokens` (5-min TTL Telegram links)
 *   - `google-oauth.ts` for `pendingStates`     (5-min TTL OAuth states)
 *
 * Both call sites use the same "set on mint, take on consume, sweep on
 * idle timer" lifecycle. Centralizing the primitive ensures the GC
 * behavior stays consistent — earlier draft had `pendingMagicTokens`
 * with no proactive sweep (unbounded growth risk) while `pendingStates`
 * had an opportunistic GC inside `mintState`. Now they share one
 * mechanism.
 */

interface TtlEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlMap<K, V> {
  private readonly entries = new Map<K, TtlEntry<V>>();

  constructor(private readonly defaultTtlMs: number) {}

  /** Insert / overwrite. Per-call `ttlMs` overrides the default. */
  set(key: K, value: V, ttlMs?: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  /**
   * Single-shot read: returns the value if present and not expired,
   * removes the entry either way (so a stale entry that's looked up
   * is gone after the call). Returns undefined on miss / expired.
   */
  take(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (Date.now() > entry.expiresAt) return undefined;
    return entry.value;
  }

  /**
   * Repeatable read: returns the value if present and not expired,
   * leaves the entry in place so subsequent reads still succeed
   * until the TTL elapses. Drops stale entries on a hit. Used by
   * magic-link auth so a user can re-open the same link within
   * its TTL window.
   */
  peek(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Drop all expired entries. Returns the number dropped. Cheap O(n);
   * call from a periodic sweep timer to bound memory in the face of
   * mint-without-consume traffic.
   */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Test-only: iterate (key, value) pairs without honoring TTL. */
  *entriesForTest(): Iterable<[K, V]> {
    for (const [key, entry] of this.entries) {
      yield [key, entry.value];
    }
  }
}
