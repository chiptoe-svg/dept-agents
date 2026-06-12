import { describe, expect, it } from 'bun:test';

import { resolvePiModel, resolvePiThinkingLevel, deriveProxyOrigin } from './pi-model.js';

describe('deriveProxyOrigin', () => {
  it('strips any path (incl. /anthropic) down to protocol//host', () => {
    expect(deriveProxyOrigin('http://192.168.64.1:3001/anthropic')).toBe('http://192.168.64.1:3001');
    expect(deriveProxyOrigin('http://192.168.64.1:3001')).toBe('http://192.168.64.1:3001');
  });
  it('falls back to the default proxy origin when unset or malformed', () => {
    expect(deriveProxyOrigin(undefined)).toBe('http://host.docker.internal:3001');
    expect(deriveProxyOrigin('not a url')).toBe('http://host.docker.internal:3001');
  });
});

describe('resolvePiModel', () => {
  it('requires an explicit model provider', () => {
    expect(() => resolvePiModel({ model: 'haiku' })).toThrow(/model provider/i);
  });

  it('maps anthropic aliases to concrete Pi models', () => {
    const model = resolvePiModel({ modelProvider: 'anthropic', model: 'haiku' });
    expect(model.provider).toBe('anthropic');
    expect(model.id).toContain('claude');
  });

  it('passes through full model ids', () => {
    const model = resolvePiModel({ modelProvider: 'anthropic', model: 'claude-sonnet-4-20250514' });
    expect(model.id).toBe('claude-sonnet-4-20250514');
  });

  it('passes through non-anthropic providers without alias rewriting', () => {
    const model = resolvePiModel({ modelProvider: 'openrouter', model: 'openai/gpt-4.1-mini' });
    expect(model.provider).toBe('openrouter');
    expect(model.id).toBe('openai/gpt-4.1-mini');
  });

  it('builds omlx/clemson baseUrls from the proxy ORIGIN, ignoring the /anthropic path prefix', () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://192.168.64.1:3001/anthropic';
    try {
      const local = resolvePiModel({ modelProvider: 'local', model: 'Qwen3.6-35B' });
      expect(local.baseUrl).toBe('http://192.168.64.1:3001/omlx/v1'); // NOT /anthropic/omlx/v1
      const clemson = resolvePiModel({ modelProvider: 'clemson', model: 'some-model' });
      expect(clemson.baseUrl).toBe('http://192.168.64.1:3001/clemson/v1');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  it('maps configured effort to anthropic thinking levels only', () => {
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'low' })).toBe('minimal');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'medium' })).toBe('low');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'high' })).toBe('medium');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'xhigh' })).toBe('high');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'max' })).toBe('xhigh');
    expect(resolvePiThinkingLevel({ modelProvider: 'openrouter', effort: 'max' })).toBeUndefined();
  });
});
