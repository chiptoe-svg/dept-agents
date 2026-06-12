import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

/**
 * Clemson's RCD-hosted LLM endpoint (`https://llm.rcd.clemson.edu`).
 * OpenAI-compatible API. Institution-paid — no per-token billing for
 * the classroom. The instructor's `CAMPUS_LLM_API_KEY` (set in `.env`)
 * is substituted by the credential-proxy on `/clemson/*` traffic and
 * shared across all students in the class pool.
 *
 * FERPA/data sovereignty: requests stay on Clemson's network; nothing
 * is sent to OpenAI/Anthropic. Preferred default for classroom use.
 *
 * Models discovered live via `curl /v1/models` 2026-05-26. Re-fetch
 * and reconcile periodically — the endpoint may add/remove models
 * without notice. Embedding + rerank models (`qwen3-embedding-4b`,
 * `qwen3-rerank-4b`) and per-user LoRA variants are omitted from this
 * catalog — they're RAG-pipeline pieces, not chat model picks.
 */
registerProvider({
  id: 'clemson',
  displayName: 'Clemson',
  proxyRoutePrefix: '/clemson/',
  credentialFileShape: 'none',
  catalogModels: [
    {
      id: 'deepseek-v4-pro',
      modelProvider: 'clemson',
      displayName: 'deepseek-v4-pro',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '🧠 reasoning'],
      notes: 'DeepSeek V4 Pro on Clemson RCD. Strong reasoning, math, coding.',
      bestFor: 'Hardest reasoning and code-heavy tasks without sending data off-campus.',
      default: true,
    },
    {
      id: 'qwen3.6-35b-a3b-fp8',
      modelProvider: 'clemson',
      displayName: 'Qwen 35B-A3B',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '35B (sparse A3B)',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '🛠 agentic'],
      notes: 'Same model family as the local OMLX Qwen, served at campus tier (no quantization slowdown).',
      bestFor: 'Agentic workflows, tool use, longer outputs.',
    },
    {
      id: 'qwen3.6-27b-fp8',
      modelProvider: 'clemson',
      displayName: 'qwen3.6-27b-fp8',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '27B',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free'],
      notes: 'Mid-size Qwen 3.6, fp8.',
      bestFor: 'Balanced reasoning/speed for general chat.',
    },
    {
      id: 'qwen3-30b-a3b-instruct-fp8',
      modelProvider: 'clemson',
      displayName: 'qwen3-30b-a3b-instruct-fp8',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '30B (sparse A3B)',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '🛠 agentic'],
      notes: 'Qwen 3 instruct, sparse architecture.',
      bestFor: 'Tool-using agents, instruction-following at lower latency than 35B.',
    },
    {
      id: 'qwen3-omni-30b-a3b',
      modelProvider: 'clemson',
      displayName: 'qwen3-omni-30b-a3b',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '30B (sparse A3B)',
      modalities: ['text', 'image', 'audio'],
      chips: ['🏛 Clemson', '🆓 free', '🎧 multimodal'],
      notes: 'Multi-modal Qwen 3 (text + image + audio).',
      bestFor: 'Vision/audio tasks without sending media off-campus.',
    },
    {
      id: 'qwen3.5-9b',
      modelProvider: 'clemson',
      displayName: 'qwen3.5-9b',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '9B',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '⚡ fast'],
      notes: 'Small fast Qwen.',
      bestFor: 'Subagents, classification, short answers when speed matters.',
    },
    {
      id: 'glm-5.1-fp8',
      modelProvider: 'clemson',
      displayName: 'glm-5.1-fp8',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free'],
      notes: 'Zhipu GLM 5.1.',
      bestFor: 'Bilingual English/Chinese; agentic workflows.',
    },
    {
      id: 'gptoss-120b',
      modelProvider: 'clemson',
      displayName: 'gptoss-120b',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '120B',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '🐢 slower'],
      notes: 'Large open-weights model.',
      bestFor: 'Heavy reasoning when latency is acceptable.',
    },
    {
      id: 'gptoss-20b',
      modelProvider: 'clemson',
      displayName: 'gptoss-20b',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '20B',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free', '⚡ fast'],
      notes: 'Smaller gptoss for fast iteration.',
      bestFor: 'Quick drafts, iteration loops.',
    },
    {
      id: 'gemma-4-31b',
      modelProvider: 'clemson',
      displayName: 'gemma-4-31b',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      paramCount: '31B',
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free'],
      notes: 'Google Gemma 4.',
      bestFor: 'General chat with a different model family for comparison.',
    },
    {
      id: 'leanstral-2603',
      modelProvider: 'clemson',
      displayName: 'leanstral-2603',
      origin: 'cloud',
      costPer1kTokensUsd: 0,
      modalities: ['text'],
      chips: ['🏛 Clemson', '🆓 free'],
      notes: 'Mistral-family variant on Clemson RCD.',
      bestFor: 'Balanced general use.',
    },
  ] satisfies ModelEntry[],
});
