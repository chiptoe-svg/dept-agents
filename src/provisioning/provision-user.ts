/**
 * The provisioning primitive — creates one fully-isolated NanoClaw user
 * from a display name + email: user row, agent group + filesystem, DM-style
 * playground messaging group, wiring, and a durable login token.
 *
 * Extracted from `scripts/init-first-agent.ts`, which does the same stack
 * for real DM channels (discord, telegram, ...). This module mirrors its
 * messaging-group + wiring shape exactly for the `playground` channel, so a
 * provisioned user's messages actually route to their agent — deviating
 * there would produce a user who can log in but whose messages go nowhere.
 */
import { getDb } from '../db/connection.js';
import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { updateContainerConfigScalars } from '../db/container-configs.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser, getUser } from '../modules/permissions/db/users.js';
import { initGroupFilesystem } from '../group-init.js';
import { issueClassLoginToken, publicPlaygroundBaseUrl } from '../class-login-tokens.js';
import type { AgentGroup } from '../types.js';

export interface ProvisionUserInput {
  displayName: string;
  email: string;
}

export interface ProvisionResult {
  userId: string;
  agentGroupId: string;
  folder: string;
  loginUrl: string;
}

/** Lowercase, [a-z0-9_] only, collapsed underscores, trimmed. Never empty. */
function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'user';
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Provision a brand-new, fully-isolated playground user: their own agent
 * group (provider='pi'), filesystem scaffold, a `playground` messaging
 * group wired to that agent exactly like a DM channel, and a durable login
 * token/URL.
 *
 * Idempotency: throws if a user with the derived id already exists — never
 * silently re-provisions or double-mints a token for an existing identity.
 *
 * Failure safety: every DB write (createUser, createAgentGroup, addMember,
 * createMessagingGroup, createMessagingGroupAgent) plus the
 * `initGroupFilesystem` call run inside one `getDb().transaction(...)`
 * callback. `initGroupFilesystem` is filesystem work, not itself part of
 * the atomic DB write set — but calling it inside the transaction callback
 * means that if it throws (e.g. a permissions error creating the group
 * dir), better-sqlite3 rolls back every DB row written so far in the same
 * callback before rethrowing. `initGroupFilesystem`'s own steps are each
 * gated on "does this already exist" checks, so a filesystem write that
 * partially completed before the throw is safe to encounter again on a
 * retry — it just skips what's already there. `issueClassLoginToken` runs
 * strictly LAST, after the transaction has committed, so a token is never
 * minted for a user whose DB rows or filesystem scaffold didn't fully land.
 */
export function provisionUser(input: ProvisionUserInput): ProvisionResult {
  const slug = slugify(input.displayName);
  const userId = `playground:${slug}`;

  const existingUser = getUser(userId);
  if (existingUser) {
    throw new Error(
      `User ${userId} already exists (display name: ${existingUser.display_name ?? 'unknown'}) — refusing to re-provision`,
    );
  }

  // Folder namespace is shared across every agent group, not just
  // playground-provisioned ones — suffix on collision rather than throwing,
  // since a folder clash here doesn't imply the same identity as above.
  let folder = slug;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${slug}_${suffix}`;
    suffix++;
  }

  const now = new Date().toISOString();
  const agentGroupId = generateId('ag');

  const provision = getDb().transaction((): void => {
    createUser({ id: userId, kind: 'playground', display_name: input.displayName, created_at: now });

    createAgentGroup({
      id: agentGroupId,
      name: input.displayName,
      folder,
      agent_provider: 'pi',
      created_at: now,
      metadata: JSON.stringify({ email: input.email }),
    });
    const ag: AgentGroup = getAgentGroupByFolder(folder)!;

    initGroupFilesystem(ag, {
      instructions:
        `# ${input.displayName}\n\n` +
        `You are a personal NanoClaw agent for ${input.displayName}. ` +
        'Introduce yourself briefly and invite them to chat. Keep replies concise.',
    });

    // The Plan-1 footgun: initGroupFilesystem's ensureContainerConfig seeds
    // a container_configs row with provider=NULL. Without this explicit
    // set, the container dies at startup with a misleading "Module not
    // found" instead of running the pi harness.
    updateContainerConfigScalars(agentGroupId, { provider: 'pi' });

    addMember({ user_id: userId, agent_group_id: agentGroupId, added_by: null, added_at: now });

    // Playground messaging group, wired exactly like a DM channel (mirrors
    // scripts/init-first-agent.ts's wireIfMissing for is_group=0): "respond
    // to everything" via the '.' pattern sentinel.
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: 'playground',
      platform_id: `playground:${folder}`,
      name: input.displayName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mgId,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  });
  provision();

  // Minted last, only after the DB transaction committed and the
  // filesystem scaffold succeeded — never leaves a live token for a
  // half-provisioned user.
  const token = issueClassLoginToken(userId);
  const loginUrl = `${publicPlaygroundBaseUrl()}/?token=${token}`;

  return { userId, agentGroupId, folder, loginUrl };
}
