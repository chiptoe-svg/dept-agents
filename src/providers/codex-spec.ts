import { registerProvider } from './auth-registry.js';
import type { ModelEntry } from '../model-catalog.js';

// Values sourced from docs/providers/oauth-endpoints.md (Codex v0.124.0).
// Re-verify after major @openai/codex version bumps.
// Note: codex CLI's redirectUri is `http://localhost:<ephemeral>/auth/callback`
// — a loopback listener for the CLI's own desktop flow. For NanoClaw's
// web-driven paste-back flow we use the loopback form below; OpenAI's
// OAuth server accepts loopback URIs for this client. The actual port
// doesn't matter — the user never lands on it (paste-back).
registerProvider({
  id: 'codex',
  displayName: 'OpenAI subscription',
  proxyRoutePrefix: '/openai/',
  credentialFileShape: 'mixed',
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'form',
    connectInstructions: [
      '1. Sign in to your OpenAI account in the new tab.',
      '2. Click "Authorize".',
      '3. Your browser will try to load "localhost:1455" and FAIL — this is expected.',
      '4. Look at the URL bar. It will show:',
      '   http://localhost:1455/auth/callback?code=ac_...&state=...',
      '5. Copy the entire URL (or just the value of the "code" parameter) and paste below.',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
  // Codex model entries — IDs + descriptions + pricing pulled verbatim
  // from OpenAI's docs:
  //   https://developers.openai.com/codex/models
  //   https://developers.openai.com/api/docs/pricing
  // Per-1M tokens → per-1k (divide by 1000). Update when OpenAI ships new
  // codex models or revises pricing — the auto-refresh task on the
  // post-class punch list will eventually keep this in sync automatically.
  catalogModels: [
    {
      id: 'gpt-5.5',
      modelProvider: 'openai-codex',
      displayName: 'gpt-5.5',
      origin: 'cloud',
      costPer1kInUsd: 0.005,
      costPer1kOutUsd: 0.03,
      costPer1kCachedInUsd: 0.0005,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '🔝 frontier'],
      notes: "OpenAI's newest frontier codex model — complex coding, computer use, knowledge work, research.",
      bestFor: 'Hardest reasoning + multi-step coding tasks.',
      default: true,
    },
    {
      id: 'gpt-5.4',
      modelProvider: 'openai-codex',
      displayName: 'gpt-5.4',
      origin: 'cloud',
      costPer1kInUsd: 0.0025,
      costPer1kOutUsd: 0.015,
      costPer1kCachedInUsd: 0.00025,
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '$$ pricier'],
      notes: 'Flagship — GPT-5.3-Codex coding capabilities + stronger reasoning, tool use, agentic workflows.',
      bestFor: 'Professional work blending coding with broader agentic flows.',
    },
    {
      id: 'gpt-5.4-mini',
      modelProvider: 'openai-codex',
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
      modelProvider: 'openai-codex',
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
      modelProvider: 'openai-codex',
      displayName: 'gpt-5.2',
      origin: 'cloud',
      // Pricing not on current pricing page (older general-purpose model);
      // omit rather than guess. The aggregator falls back to $0 cost which
      // is wrong but conservative — surface a warning if you start charging
      // students for 5.2 usage.
      modalities: ['text', 'image'],
      chips: ['☁ OpenAI', '⏮ previous gen'],
      notes: 'Previous general-purpose codex model — hard debugging tasks needing deeper deliberation.',
      bestFor: 'Long-thinking debugging when newer models feel rushed.',
    },
  ] satisfies ModelEntry[],
});
