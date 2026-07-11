import { registerResource } from '../crud.js';
import { provisionUser } from '../../provisioning/provision-user.js';

registerResource({
  name: 'user',
  plural: 'users',
  table: 'users',
  description:
    'User — a messaging-platform identity. Each row is one sender on one channel. A single human may have multiple user rows across channels (no cross-channel linking yet).',
  idColumn: 'id',
  // No agent-group column on this table — a user identity can span multiple
  // groups. An agent caller has no legitimate cross-tenant read of every
  // user's handle/phone/email, so this resource is fully blocked for agent
  // callers rather than partially scoped.
  scopeColumn: null,
  columns: [
    {
      name: 'id',
      type: 'string',
      description:
        'Namespaced "channel_type:handle" — e.g. "tg:6037840640", "discord:123456789", "email:user@example.com". Must be provided on create.',
      required: true,
    },
    {
      name: 'kind',
      type: 'string',
      description:
        'Channel type identifier (e.g. "telegram", "discord"). Used as a fallback for DM resolution when the id prefix doesn\'t match a registered adapter.',
      required: true,
    },
    {
      name: 'display_name',
      type: 'string',
      description:
        'Human-readable name. Shown in approval cards and logs. Often auto-populated from the channel adapter.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    provision: {
      access: 'approval',
      description:
        'Provision a brand-new, fully-isolated playground user — user row, agent group + filesystem, ' +
        'playground messaging group wired to that agent, and a durable login token. Use --display-name ' +
        '"<name>" --email <email>. Prints the login URL to distribute.',
      handler: async (args) => {
        const displayName = args.display_name as string;
        const email = args.email as string;
        if (!displayName) throw new Error('--display-name is required');
        if (!email) throw new Error('--email is required');
        const result = provisionUser({ displayName, email });
        return {
          ok: true,
          userId: result.userId,
          agentGroupId: result.agentGroupId,
          loginUrl: result.loginUrl,
        };
      },
    },
  },
});
