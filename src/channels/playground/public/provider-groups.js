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
export const PROVIDER_GROUPS = [
  { id: 'openai', displayName: 'OpenAI', specIds: ['codex', 'openai-platform'] },
  { id: 'anthropic', displayName: 'Anthropic', specIds: ['claude'] },
  { id: 'local', displayName: 'Local', specIds: ['omlx'] },
  { id: 'clemson', displayName: 'Clemson', specIds: ['clemson'] },
];
