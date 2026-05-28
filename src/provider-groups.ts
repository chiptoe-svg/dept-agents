/**
 * Server-side mirror of `src/channels/playground/public/provider-groups.js`.
 *
 * Same 4 user-facing groups, plus each member's `modelProvider` name (the
 * catalog field — what pi.ts routes on and what chat.js writes into
 * `container_configs.model_provider`). The frontend module can't be
 * imported from server code (different module systems, different build),
 * so we duplicate. Keep the two in sync when adding a group.
 */

export interface ProviderGroupMember {
  /** auth-registry spec id (claude, codex, openai-platform, omlx, clemson). */
  specId: string;
  /** catalog `modelProvider` field — what pi.ts dispatches on. */
  modelProvider: string;
}

export interface ProviderGroup {
  /** User-facing group id (openai, anthropic, local, clemson). */
  id: string;
  displayName: string;
  members: ProviderGroupMember[];
  /** The spec dialog opens / the resolver prefers when only one applies. */
  canonicalSpecId: string;
}

export const PROVIDER_GROUPS: ProviderGroup[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    canonicalSpecId: 'codex',
    members: [
      { specId: 'codex', modelProvider: 'openai-codex' },
      { specId: 'openai-platform', modelProvider: 'openai-platform' },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    canonicalSpecId: 'claude',
    members: [{ specId: 'claude', modelProvider: 'anthropic' }],
  },
  {
    id: 'local',
    displayName: 'Local (OMLX)',
    canonicalSpecId: 'omlx',
    members: [{ specId: 'omlx', modelProvider: 'local' }],
  },
  {
    id: 'clemson',
    displayName: 'Clemson',
    canonicalSpecId: 'clemson',
    members: [{ specId: 'clemson', modelProvider: 'clemson' }],
  },
];

export function findGroupById(id: string): ProviderGroup | undefined {
  return PROVIDER_GROUPS.find((g) => g.id === id);
}
