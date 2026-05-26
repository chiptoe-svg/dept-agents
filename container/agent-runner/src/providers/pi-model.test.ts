import { describe, expect, it } from 'bun:test';

import { resolvePiModel, resolvePiThinkingLevel } from './pi-model.js';

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

  it('maps configured effort to anthropic thinking levels only', () => {
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'low' })).toBe('minimal');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'medium' })).toBe('low');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'high' })).toBe('medium');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'xhigh' })).toBe('high');
    expect(resolvePiThinkingLevel({ modelProvider: 'anthropic', effort: 'max' })).toBe('xhigh');
    expect(resolvePiThinkingLevel({ modelProvider: 'openrouter', effort: 'max' })).toBeUndefined();
  });
});
