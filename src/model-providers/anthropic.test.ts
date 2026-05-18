import { describe, it, expect } from 'vitest';

import { anthropicAdapter, STATIC_CLAUDE } from './anthropic.js';

describe('anthropic adapter parseId', () => {
  it.each([
    ['claude-opus-4-7', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
  ])('%s → alias %s', (id, expectedAlias) => {
    const p = anthropicAdapter.parseId(id);
    expect(p?.alias).toBe(expectedAlias);
    expect(p?.bucket).toBe(expectedAlias);
    expect(p?.id).toBe(id);
  });

  it('returns null for unknown ids', () => {
    expect(anthropicAdapter.parseId('claude-2')).toBeNull();
    expect(anthropicAdapter.parseId('gpt-5.5')).toBeNull();
    expect(anthropicAdapter.parseId('')).toBeNull();
  });

  it('rank tuple is [major, minor, date]', () => {
    expect(anthropicAdapter.parseId('claude-opus-4-7')?.rank).toEqual([4, 7, 0]);
    expect(anthropicAdapter.parseId('claude-haiku-4-5-20251001')?.rank).toEqual([4, 5, 20251001]);
  });
});

describe('anthropic adapter pickTop', () => {
  it('returns latest of each tier in opus → sonnet → haiku order', () => {
    const ids = [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
      'claude-haiku-3-5',
      'claude-2', // ignored
    ];
    const parsed = ids.map((id) => anthropicAdapter.parseId(id)).filter((p) => p !== null);
    const top = anthropicAdapter.pickTop(parsed, 4);
    expect(top.map((m) => m.alias)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(top[0].id).toBe('claude-opus-4-7');
    expect(top[1].id).toBe('claude-sonnet-4-6');
    expect(top[2].id).toBe('claude-haiku-4-5-20251001');
  });

  it('handles partial coverage (only sonnet available)', () => {
    const parsed = [anthropicAdapter.parseId('claude-sonnet-4-6')].filter((p) => p !== null);
    const top = anthropicAdapter.pickTop(parsed, 4);
    expect(top).toHaveLength(1);
    expect(top[0].alias).toBe('sonnet');
  });

  it('caps at maxCount', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `claude-opus-4-${i}`);
    const parsed = ids.map((id) => anthropicAdapter.parseId(id)).filter((p) => p !== null);
    const top = anthropicAdapter.pickTop(parsed, 4);
    expect(top.length).toBeLessThanOrEqual(4);
  });
});

describe('anthropic adapter noteFor', () => {
  it.each([
    ['opus', /Opus/],
    ['sonnet', /Sonnet/],
    ['haiku', /Haiku/],
  ])('%s has a curated note', (alias, expected) => {
    expect(anthropicAdapter.noteFor(alias)).toMatch(expected);
  });

  it('returns undefined for unknown aliases', () => {
    expect(anthropicAdapter.noteFor('nonexistent')).toBeUndefined();
  });
});

describe('anthropic adapter shape', () => {
  it('has the expected metadata', () => {
    expect(anthropicAdapter.name).toBe('claude');
    expect(anthropicAdapter.defaultHost).toBe('api.anthropic.com');
    expect(anthropicAdapter.envBaseUrlVar).toBe('ANTHROPIC_BASE_URL');
    expect(anthropicAdapter.modelsPath).toBe('/v1/models');
    expect(anthropicAdapter.extraHeaders).toMatchObject({ 'anthropic-version': '2023-06-01' });
  });

  it('staticFallback contains opus/sonnet/haiku', () => {
    expect(STATIC_CLAUDE.map((m) => m.alias)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
