/**
 * UI-side provider grouping. The Class Controls form and Home Providers
 * card render one row per user-facing group; underneath, each group maps
 * to one or more registered auth-registry spec ids.
 *
 * Why hard-coded: the user-facing list is intentionally a curated 4 — it's
 * the mental model the instructor and students operate on. Registered
 * specs (and the credential-proxy routing keyed on them) stay flexible
 * underneath. See plans/class-controls-provider-grouping.md.
 */
/**
 * Per-group metadata for the instructor LLM Providers card:
 *
 *   canonicalSpecId — which spec the [Manage] button opens. For mixed
 *     groups (OpenAI, Anthropic) this is the spec with `credentialFileShape:
 *     'mixed'` — its cred dialog already exposes both Connect-subscription
 *     and Paste-API-key flows in one place.
 *   hasMixed — render the inline "subscription | API key" active-method
 *     radio. The radio writes to canonicalSpec.creds.active, which the
 *     C-1 class-pool resolver reads.
 *   specIds — full set of underlying specs. "Apply to class" sets allow +
 *     provideDefault on every member.
 *
 * Cross-spec note: for the OpenAI group the canonical spec is `codex`
 * (mixed). The proxy's `/openai-platform/*` route looks up
 * `openai-platform` creds at request time — when the instructor's API
 * key is stored under codex, the C-1 resolver's sibling-fallback
 * (see SIBLING_API_KEY_SPECS in src/classroom-provider-resolver.ts)
 * makes it visible on the openai-platform path too.
 */
export const PROVIDER_GROUPS = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    specIds: ['codex', 'openai-platform'],
    // Member catalog modelProvider names — what the catalog entries
    // carry on their `modelProvider` field. Used by chat.js to fold
    // catalog rows into a single per-group provider in the dropdown.
    memberModelProviders: ['openai-codex', 'openai-platform'],
    canonicalSpecId: 'codex',
    hasMixed: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    specIds: ['claude'],
    memberModelProviders: ['anthropic'],
    canonicalSpecId: 'claude',
    hasMixed: true,
  },
  {
    id: 'local',
    displayName: 'Local (OMLX)',
    specIds: ['omlx'],
    memberModelProviders: ['local'],
    canonicalSpecId: 'omlx',
    hasMixed: false,
  },
  {
    id: 'clemson',
    displayName: 'Clemson',
    specIds: ['clemson'],
    memberModelProviders: ['clemson'],
    canonicalSpecId: 'clemson',
    hasMixed: false,
  },
];
