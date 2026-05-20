import { describe, it, expect } from 'vitest';

import { openaiAdapter, STATIC_CODEX } from './openai.js';

describe('openai adapter parseId', () => {
  it.each([
    ['gpt-5.5', '5.5'],
    ['gpt-5.4', '5.4'],
    ['gpt-5.4-mini', '5.4mini'],
    ['gpt-5.3-codex', '5.3codex'],
  ])('%s → alias %s', (id, expectedAlias) => {
    expect(openaiAdapter.parseId(id)?.alias).toBe(expectedAlias);
  });

  it('rejects multi-segment legacy ids and embedding/dall-e ids', () => {
    expect(openaiAdapter.parseId('gpt-3.5-turbo-instruct')).toBeNull();
    expect(openaiAdapter.parseId('gpt-4.0-turbo-preview')).toBeNull();
    expect(openaiAdapter.parseId('davinci-002')).toBeNull();
    expect(openaiAdapter.parseId('text-embedding-ada-002')).toBeNull();
  });
});

describe('openai adapter pickTop', () => {
  it('sorts newest first; base before mini/codex variants at the same version', () => {
    const ids = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'];
    const parsed = ids.map((id) => openaiAdapter.parseId(id)).filter((p) => p !== null);
    const top = openaiAdapter.pickTop(parsed, 4);
    expect(top.map((m) => m.alias)).toEqual(['5.5', '5.4', '5.4mini', '5.3codex']);
  });

  it('caps at maxCount', () => {
    const ids = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3', 'gpt-5.3-codex', 'gpt-5.2'];
    const parsed = ids.map((id) => openaiAdapter.parseId(id)).filter((p) => p !== null);
    const top = openaiAdapter.pickTop(parsed, 4);
    expect(top).toHaveLength(4);
  });
});

describe('openai adapter noteFor', () => {
  it.each([['5.5'], ['5.4'], ['5.4mini']])('%s has a curated note', (alias) => {
    expect(openaiAdapter.noteFor(alias)).toBeDefined();
  });

  it('returns undefined for unknown aliases', () => {
    expect(openaiAdapter.noteFor('99.9')).toBeUndefined();
  });
});

describe('openai adapter shape', () => {
  it('has the expected metadata', () => {
    expect(openaiAdapter.name).toBe('codex');
    expect(openaiAdapter.defaultHost).toBe('api.openai.com');
    expect(openaiAdapter.envBaseUrlVar).toBe('OPENAI_BASE_URL');
    expect(openaiAdapter.modelsPath).toBe('/v1/models');
  });

  it('staticFallback has 5 entries by alias', () => {
    expect(STATIC_CODEX.map((m) => m.alias)).toEqual(['5.5', '5.4', '5.4mini', '5.3codex', '5.2']);
  });
});
