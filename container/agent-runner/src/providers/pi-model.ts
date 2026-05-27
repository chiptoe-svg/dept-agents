import { getModel, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

/**
 * Synthesize an OpenAI-compatible Model object for providers pi-ai's
 * built-in catalog (models.generated.js) doesn't know about — Clemson's
 * RCD endpoint and local OMLX server. Both speak the OpenAI Chat
 * Completions API; both are routed through the host credential-proxy
 * which substitutes the real bearer (CAMPUS_LLM_API_KEY / OMLX_API_KEY)
 * at the wire level.
 *
 * Why synthesize rather than upstream a PR to pi-ai: pi-ai treats Model
 * objects as plain data — `Provider` and `Api` are open-ended strings
 * (KnownProvider | string) — so handing it a hand-rolled Model object
 * works without any pi-ai code change. The HTTP client picks the right
 * endpoint shape from `api: 'openai-completions'`.
 *
 * The baseUrl reuses the credential-proxy host from ANTHROPIC_BASE_URL
 * (the same proxy serves all routes on the same port). Adding a new path
 * prefix routes the request through the matching proxy branch.
 *
 * contextWindow defaulted to 32768 — safe for the Qwen 3.x family.
 * Specific models can override (DeepSeek V4 has 128k, gemma-4 has 8k,
 * etc.). The downstream cost-tracking machinery treats cost: 0 as
 * "free" (institution-paid for Clemson, host-runs-it for OMLX).
 */
function synthesizeOpenAICompatibleModel(input: {
  provider: string;
  modelId: string;
  proxyPathPrefix: string;
  contextWindow?: number;
}): Model<'openai-completions'> {
  const proxyHost = process.env.ANTHROPIC_BASE_URL ?? 'http://host.docker.internal:3001';
  return {
    id: input.modelId,
    name: input.modelId,
    api: 'openai-completions',
    provider: input.provider,
    baseUrl: `${proxyHost}${input.proxyPathPrefix}`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 32_768,
    maxTokens: 4096,
  };
}

export function resolvePiModel(input: { modelProvider?: string; model?: string }): Model<any> {
  const provider = input.modelProvider;
  if (!provider) {
    throw new Error('Pi provider requires an explicit model provider');
  }
  const requested = input.model ?? 'haiku';

  // Clemson RCD-hosted endpoint — synthesize the Model so pi-ai's HTTP
  // client routes through the credential-proxy's /clemson/* prefix.
  // The `/v1` suffix is load-bearing: pi-ai uses the OpenAI Node SDK
  // which appends `/chat/completions` directly to baseUrl (it assumes
  // `/v1` is already part of the URL — same convention as the
  // OPENAI_BASE_URL env var elsewhere in this codebase).
  if (provider === 'clemson') {
    if (!requested) throw new Error('clemson provider requires an explicit model id');
    return synthesizeOpenAICompatibleModel({
      provider,
      modelId: requested,
      proxyPathPrefix: '/clemson/v1',
    });
  }

  // OMLX local server — same pattern, /omlx/v1 prefix on the proxy.
  if (provider === 'local') {
    if (!requested) throw new Error('local provider requires an explicit model id');
    return synthesizeOpenAICompatibleModel({
      provider: 'local',
      modelId: requested,
      proxyPathPrefix: '/omlx/v1',
    });
  }

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
