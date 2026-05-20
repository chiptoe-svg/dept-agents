import { registerProvider } from './auth-registry.js';

// Values sourced from docs/providers/oauth-endpoints.md (Claude Code v2.1.116).
// Re-verify after major @anthropic-ai/claude-code version bumps.
registerProvider({
  id: 'claude',
  displayName: 'Anthropic',
  proxyRoutePrefix: '', // anthropic is the default route in credential-proxy
  credentialFileShape: 'mixed',
  oauth: {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    // org:create_api_key was in Claude Code's request set but Anthropic
    // silently drops it on grant (smoke-tested 2026-05-17). Omitted here.
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'json',
    connectInstructions: [
      '1. Sign in to your Anthropic account in the new tab.',
      '2. Click "Authorize".',
      '3. Anthropic will display an authorization code on the next page.',
      '4. Copy the code (it may be combined with state separated by "#" — paste the whole thing).',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-ant-api03-…',
    validatePrefix: 'sk-ant-',
  },
});
