import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { recordBackstopUse, getBackstopUse } from './backstop-usage.js';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('backstop usage', () => {
  it('records and reads back the latest backstop use', () => {
    recordBackstopUse('ag_x', 'openai');
    const r = getBackstopUse('ag_x');
    expect(r?.providerId).toBe('openai');
    expect(typeof r?.at).toBe('string');
  });

  it('upserts — the latest use wins', () => {
    // With a per-group (not per-provider) debounce, two immediate calls
    // would have the second suppressed by the 60s window even though the
    // provider changed. Advance fake time past the window between the two
    // writes so this still meaningfully exercises the upsert-overwrite
    // path rather than accidentally re-testing the debounce.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      recordBackstopUse('ag_x', 'openai');
      vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
      recordBackstopUse('ag_x', 'anthropic');
      expect(getBackstopUse('ag_x')?.providerId).toBe('anthropic');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null for a group that never used the backstop', () => {
    expect(getBackstopUse('ag_never')).toBeNull();
  });

  it('debounces: two same-provider calls within the 60s window produce one write (at unchanged)', () => {
    // Fake timers so the two calls land at deterministically DIFFERENT
    // clock instants (real Date.now() calls back-to-back can coincide on
    // the same millisecond, which would make `at` equal even without any
    // debounce logic — a false pass). This makes the test actually catch
    // the mutation: removing the debounce advances `at` by 1s.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      recordBackstopUse('ag_deb', 'openai');
      const after1 = getBackstopUse('ag_deb');

      // Advance by 1s — still well inside the 60s debounce window.
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      recordBackstopUse('ag_deb', 'openai');
      const after2 = getBackstopUse('ag_deb');

      expect(after2?.at).toBe(after1?.at);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces per-group, not per-provider: alternating providers within the window still produce one write', () => {
    // Proves the debounce key is the group alone. If the skip condition
    // were still gated on `existing.providerId === providerId`, a provider
    // switch would force a write every time — reproducing the hot-path
    // DB-write storm the debounce exists to prevent.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      recordBackstopUse('ag_alt', 'claude');
      const after1 = getBackstopUse('ag_alt');

      // Still well inside the 60s window, but a *different* provider.
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      recordBackstopUse('ag_alt', 'openai-codex');
      const after2 = getBackstopUse('ag_alt');

      // Suppressed write: timestamp unchanged AND providerId still the
      // first call's, since the second call never reached the upsert.
      expect(after2?.at).toBe(after1?.at);
      expect(after2?.providerId).toBe('claude');
    } finally {
      vi.useRealTimers();
    }
  });
});
