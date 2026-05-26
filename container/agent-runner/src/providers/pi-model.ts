import { getModel, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export function resolvePiModel(input: { modelProvider?: string; model?: string }): Model<any> {
  const provider = input.modelProvider;
  if (!provider) {
    throw new Error('Pi provider requires an explicit model provider');
  }
  const requested = input.model ?? 'haiku';
  const resolvedId =
    provider === 'anthropic' && requested === 'haiku'
      ? 'claude-haiku-4-5'
      : provider === 'anthropic' && requested === 'sonnet'
        ? 'claude-sonnet-4-5'
        : requested;

  return getModel(provider as never, resolvedId as never);
}

export function resolvePiThinkingLevel(input: {
  modelProvider?: string;
  effort?: string;
}): ThinkingLevel | undefined {
  if (input.modelProvider !== 'anthropic') return undefined;

  switch (input.effort) {
    case 'low':
      return 'minimal';
    case 'medium':
      return 'low';
    case 'high':
      return 'medium';
    case 'xhigh':
      return 'high';
    case 'max':
      return 'xhigh';
    default:
      return undefined;
  }
}
