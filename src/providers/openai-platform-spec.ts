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
  catalogModels: [
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
      notes: "OpenAI's newest frontier model — complex coding, computer use, knowledge work, research.",
      bestFor: 'Hardest reasoning + multi-step coding tasks.',
      default: true,
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
      chips: ['☁ OpenAI', '$$ pricier'],
      notes: 'Flagship — coding capabilities + stronger reasoning, tool use, agentic workflows.',
      bestFor: 'Professional work blending coding with broader agentic flows.',
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
      notes: 'Fast, efficient mini model for responsive coding tasks and subagents.',
      bestFor: 'Short tasks, classification, subagents — when latency matters more than depth.',
    },
    {
      id: 'gpt-5.3-codex',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.3-codex',
      origin: 'cloud',
      costPer1kInUsd: 0.00175,
      costPer1kOutUsd: 0.014,
      costPer1kCachedInUsd: 0.000175,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '💻 code'],
      notes: 'Industry-leading coding model — its coding capabilities also power GPT-5.4.',
      bestFor: 'Complex software engineering when you want the pure code-tuned model.',
    },
    {
      id: 'gpt-5.2',
      modelProvider: 'openai-platform',
      displayName: 'gpt-5.2',
      origin: 'cloud',
      // Pricing not on current pricing page (older general-purpose model);
      // omit rather than guess. Aggregator falls back to $0 cost which is
      // wrong but conservative — surface a warning if billable usage appears.
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⏮ previous gen'],
      notes: 'Previous general-purpose model — hard debugging tasks needing deeper deliberation.',
      bestFor: 'Long-thinking debugging when newer models feel rushed.',
    },
  ] satisfies ModelEntry[],
});
