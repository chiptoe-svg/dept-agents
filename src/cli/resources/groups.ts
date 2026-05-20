import { registerResource } from '../crud.js';

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    {
      name: 'agent_provider',
      type: 'string',
      description:
        'LLM provider. Null means the default (claude). Skill-installed providers (e.g. opencode) register via /add-<provider>. Updates cascade: every active session in this group has its `agent_provider` overwritten to match, and any running container is killed so the next message respawns under the new provider. Mirrors the playground PUT /api/drafts/:folder/provider behaviour.',
      updatable: true,
      default: null,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  async afterUpdate({ id, updates }) {
    if (!('agent_provider' in updates)) return;
    const provider = updates.agent_provider as string | null;
    // Late imports — these modules load after the CLI registry is bootstrapped,
    // and importing them at module scope would create a load-order tangle.
    const { getActiveSessions, updateSession } = await import('../../db/sessions.js');
    const { killContainer, isContainerRunning } = await import('../../container-runner.js');
    const { log } = await import('../../log.js');
    for (const s of getActiveSessions()) {
      if (s.agent_group_id !== id) continue;
      updateSession(s.id, { agent_provider: provider });
      if (isContainerRunning(s.id)) {
        try {
          killContainer(s.id, `provider switched to ${provider ?? '(unset)'}`);
        } catch (err) {
          log.warn('Failed to kill container during agent_provider cascade', { sessionId: s.id, err });
        }
      }
    }
  },
});
