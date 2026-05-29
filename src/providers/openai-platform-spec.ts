import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

registerProvider({
  id: 'openai-platform',
  displayName: 'OpenAI API',
  proxyRoutePrefix: '/openai-platform/',
  credentialFileShape: 'api-key',
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
  // Catalog mirrors codex-spec's lineup verbatim: user's empirical observation
  // is "the OpenAI Platform API offers everything the ChatGPT subscription
  // does." Same model IDs, same costs (codex-spec's costs are per-token rates
  // from OpenAI's API pricing docs and apply to both routing paths). The
  // distinction between the two providers is therefore the AUTH method
  // (subscription OAuth vs API key) + the upstream endpoint
  // (backend-api.openai.com vs api.openai.com), NOT the model menu.
  //
  // If a model ID returns 404 when invoked via api.openai.com (i.e. the
  // empirical assumption is wrong for that specific model), drop it from
  // this catalog and surface the gap in state.md.
  // Tier ladder per the 2026-05-28 review (Option B); mirrors codex-spec.ts.
  catalogModels: [
    {
      id: 'gpt-5.5-pro',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.5-pro',
      origin: 'cloud',
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '🔝 frontier', '$$$ premium'],
      notes:
        'Frontier-max tier — extends gpt-5.5 with stronger reasoning and longer thinking budgets. Pricing not on the published page; omit rather than guess.',
      bestFor: 'Hardest reasoning, complex multi-step planning, research.',
    },
    {
      id: 'gpt-5.5',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.5',
      origin: 'cloud',
      costPer1kInUsd: 0.005,
      costPer1kOutUsd: 0.03,
      costPer1kCachedInUsd: 0.0005,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '🔝 frontier'],
      notes:
        "OpenAI's frontier model — complex coding, computer use, knowledge work. Headroom above the daily driver for tough problems.",
      bestFor: 'Hard reasoning + multi-step coding when 5.4 isn’t enough.',
    },
    {
      id: 'gpt-5.4',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.4',
      origin: 'cloud',
      costPer1kInUsd: 0.0025,
      costPer1kOutUsd: 0.015,
      costPer1kCachedInUsd: 0.00025,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⚖ balanced'],
      notes: 'Daily driver — balanced quality + cost. Recommended default for most class work.',
      bestFor: 'Professional work blending coding with broader agentic flows.',
      default: true,
    },
    {
      id: 'gpt-5.4-mini',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.4-mini',
      origin: 'cloud',
      costPer1kInUsd: 0.00075,
      costPer1kOutUsd: 0.0045,
      costPer1kCachedInUsd: 0.000075,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⚡ fast', '$ cheap'],
      notes: 'Fast, efficient mini for responsive tasks and subagents.',
      bestFor: 'Short tasks, classification, subagents — when latency matters more than depth.',
    },
    {
      id: 'gpt-5.4-nano',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.4-nano',
      origin: 'cloud',
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⚡ ultra-fast', '$ cheapest'],
      notes:
        'Smallest 5.4-family variant — cheapest and fastest, lighter capability. Pricing not on the published page; omit rather than guess.',
      bestFor: 'Penny-per-turn subagents, classification, lookups.',
    },
  ] satisfies ModelEntry[],
});
