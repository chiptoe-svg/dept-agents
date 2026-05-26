import type { McpServerConfig } from '../../container-config.js';
import { materializeContainerJson } from '../../container-config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display (including classroom-only env + allowed_models). */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    env: JSON.parse(row.env),
    allowed_models: JSON.parse(row.allowed_models),
    model_provider: row.model_provider,
    updated_at: row.updated_at,
  };
}

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
  // `delete` is intentionally not in `operations` — the generic single-table
  // DELETE violates FK constraints (see #2525). The cascading handler is
  // provided as `customOperations.delete` below.
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = hasTable(db, 'agent_destinations');
        const hasPendingApprovals = hasTable(db, 'pending_approvals');

        // FK-ordered cascade. Single sync transaction — better-sqlite3 rolls
        // back the whole thing if any statement throws (e.g. an FK constraint
        // we missed), so the central DB stays consistent. The `removed` counts
        // are sourced from each DELETE's `changes` so they describe exactly
        // what the transaction did, not a separate pre-flight snapshot.
        const cascade = db.transaction((groupId: string) => {
          const counts = {
            sessions: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = db
              .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
              .run(groupId).changes;
            counts.agent_destinations_pointing = db
              .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
              .run('agent', groupId).changes;
          }
          counts.pending_questions = db
            .prepare(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
            )
            .run(groupId).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = db
              .prepare(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              )
              .run(groupId, groupId).changes;
          }
          counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
          counts.pending_sender_approvals = db
            .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.pending_channel_approvals = db
            .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.messaging_group_agents = db
            .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.agent_group_members = db
            .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
          db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
          return counts;
        });
        const removed = cascade(id);

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only.
        if (ctx.caller === 'agent') {
          if (message) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group.
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config-get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config-update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Saves and immediately materializes + restarts the container. ' +
        'Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, --model-provider.',
      handler: async (args, ctx) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
            | 'model_provider'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }
        if (args.model_provider !== undefined) updates.model_provider = args.model_provider as string;

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, --model-provider',
          );
        }

        updateContainerConfigScalars(id, updates);
        materializeContainerJson(id);
        const message = args.message as string | undefined;
        restartAgentGroupContainers(id, 'config updated', message);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config-add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Materializes config and restarts the container. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>] [--instructions <text>].',
      handler: async (args, ctx) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        const entry: McpServerConfig = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        if (args.instructions) entry.instructions = args.instructions as string;
        servers[name] = entry;
        updateContainerConfigJson(id, 'mcp_servers', servers);
        materializeContainerJson(id);
        const message = args.message as string | undefined;
        restartAgentGroupContainers(id, 'config updated', message);

        return { added: name, servers };
      },
    },
    'config-remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Materializes config and restarts the container. Use --id <group-id> --name <server-name>.',
      handler: async (args, ctx) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);
        materializeContainerJson(id);
        const message = args.message as string | undefined;
        restartAgentGroupContainers(id, 'config updated', message);

        return { removed: name };
      },
    },
    'config-add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Materializes config and restarts the container (image rebuild required for packages). ' +
        'Use --id <group-id> --kind <apt|npm> --name <pkg>.',
      handler: async (args, ctx) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const kind = args.kind as string;
        if (!kind || !['apt', 'npm'].includes(kind)) throw new Error('--kind must be apt or npm');
        const pkgName = args.name as string;
        if (!pkgName) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const jsonKey = kind === 'apt' ? 'packages_apt' : 'packages_npm';
        const existing = JSON.parse(row[jsonKey]) as string[];
        if (!existing.includes(pkgName)) {
          existing.push(pkgName);
          updateContainerConfigJson(id, jsonKey, existing);
        }
        materializeContainerJson(id);
        const message = args.message as string | undefined;
        restartAgentGroupContainers(
          id,
          'config updated',
          message ??
            `Package ${pkgName} added — image rebuild required to install it. Run ncl groups restart --rebuild to apply.`,
        );

        return {
          added: { kind, name: pkgName },
          note: 'Image rebuild required for packages to take effect. Use ncl groups restart --rebuild.',
        };
      },
    },
    'config-remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Materializes config and restarts the container (image rebuild required). ' +
        'Use --id <group-id> --kind <apt|npm> --name <pkg>.',
      handler: async (args, ctx) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const kind = args.kind as string;
        if (!kind || !['apt', 'npm'].includes(kind)) throw new Error('--kind must be apt or npm');
        const pkgName = args.name as string;
        if (!pkgName) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const jsonKey = kind === 'apt' ? 'packages_apt' : 'packages_npm';
        const existing = JSON.parse(row[jsonKey]) as string[];
        const filtered = existing.filter((p) => p !== pkgName);
        updateContainerConfigJson(id, jsonKey, filtered);
        materializeContainerJson(id);
        const message = args.message as string | undefined;
        restartAgentGroupContainers(id, 'config updated', message);

        return {
          removed: { kind, name: pkgName },
          note: 'Image rebuild required for package changes to take effect. Use ncl groups restart --rebuild.',
        };
      },
    },
  },
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
