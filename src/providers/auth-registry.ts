/**
 * Provider auth registry. Source of truth for what providers NanoClaw
 * understands auth for: their OAuth config (if any), API-key shape (if
 * any), proxy route prefix, and display name. Pure module — no I/O, no
 * side effects beyond the in-process map. Classroom-skill installation
 * adds nothing here; the registry is generic trunk infrastructure.
 */

export type ProviderAuthSpec = {
  id: string;
  displayName: string;
  proxyRoutePrefix: string; // '/openai/' | '' (anthropic default) | …
  credentialFileShape: 'oauth-token' | 'api-key' | 'mixed';
  oauth?: {
    clientId: string;
    authorizeUrl: string;
    tokenUrl: string;
    /** Vendor-pinned redirect URI — included verbatim in the
     *  authorize-URL request and the token-exchange POST.
     *  We piggyback on vendor CLI OAuth clients whose redirect_uri
     *  cannot be overridden, so the user pastes the code back rather
     *  than NanoClaw receiving a callback. */
    redirectUri: string;
    scopes: string[];
    refreshGrantBody: (refreshToken: string, clientId: string) => string;
    pkce: 'S256';
    /** Token endpoint body format for the auth-code grant. Discovered
     *  empirically (smoke test 2026-05-17): Anthropic requires JSON,
     *  OpenAI accepts standard form-urlencoded. Refresh grant is
     *  separately form-urlencoded for both per refreshGrantBody. */
    authCodeBodyFormat: 'json' | 'form';
    /** Per-provider user-facing walkthrough rendered in the Home
     *  Providers card paste form. The OpenAI/loopback flow needs
     *  different copy than Anthropic's vendor-display flow. */
    connectInstructions: string;
  };
  apiKey?: {
    placeholder: string;
    validatePrefix?: string;
  };
};

const registry = new Map<string, ProviderAuthSpec>();

export function registerProvider(spec: ProviderAuthSpec): void {
  registry.set(spec.id, spec);
}

export function getProviderSpec(id: string): ProviderAuthSpec | null {
  return registry.get(id) ?? null;
}

export function listProviderSpecs(): ProviderAuthSpec[] {
  return [...registry.values()];
}

/** Test-only — clears the registry. Not exported via the barrel. */
export function resetRegistryForTests(): void {
  registry.clear();
}
