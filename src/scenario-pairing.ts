/**
 * Generic scenario pair consumer (platform).
 *
 * Replaces the per-role classroom consumers (class-pair-greeting,
 * pair-instructor, pair-ta). After a wire-to pairing, this resolves the
 * target folder's canonical role under the ACTIVE scenario and does the
 * role-generic setup the contract describes:
 *   1. Stamp member metadata. The keys (student_email/student_name/
 *      student_user_id) are kept as-is — downstream features (Drive sharing,
 *      git-author env, per-user auth) read them; renaming is a later pass.
 *   2. Grant the role's platform permission (global-admin / scoped-admin /
 *      member).
 *   3. Return the role's greeting and suppress the channel's default reply.
 *
 * Non-member folders (roleForFolder → null) return {} so the channel sends
 * its default confirmation. Only the ACTIVE scenario is registered, so a
 * seminar box runs seminar pairing and a classroom box runs classroom
 * pairing from this one consumer. See plans/group-agent-platform.md.
 */
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { getAllAgentGroups, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { log } from './log.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { memberName, roleForFolder, roleProfile } from './scenarios/registry.js';
import type { RolePermission } from './scenarios/types.js';

/**
 * Grant the platform permission for a paired member's role.
 *  - global-admin → one global admin grant (agent_group_id null).
 *  - scoped-admin → admin on every OTHER member group (any folder whose
 *    canonical role is user or assistant), derived from the contract — no
 *    per-scenario group list needed.
 *  - member → no role grant (membership is handled at provision time).
 * Idempotent: grantRole's INSERT OR IGNORE makes re-pair safe.
 */
function grantPermissionForRole(permission: RolePermission, userId: string, targetFolder: string): void {
  const now = new Date().toISOString();
  if (permission === 'global-admin') {
    grantRole({ user_id: userId, role: 'admin', agent_group_id: null, granted_by: null, granted_at: now });
    return;
  }
  if (permission === 'scoped-admin') {
    for (const g of getAllAgentGroups()) {
      if (g.folder === targetFolder) continue; // never scope to self
      const r = roleForFolder(g.folder);
      if (r !== 'user' && r !== 'assistant') continue;
      try {
        grantRole({ user_id: userId, role: 'admin', agent_group_id: g.id, granted_by: null, granted_at: now });
      } catch (err) {
        log.error('scenario-pairing: scoped grantRole failed', {
          userId,
          targetGroup: g.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // member → nothing
}

async function scenarioPairConsumer(ctx: PairContext): Promise<PairResult> {
  const role = roleForFolder(ctx.targetFolder);
  if (!role) return {}; // not a member of the active scenario
  const profile = roleProfile(role);
  if (!profile) return {};
  const name = memberName(ctx.targetFolder) ?? ctx.targetFolder;

  // 1. Stamp metadata (key names kept for downstream features).
  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  // 2. Grant permission per role.
  try {
    grantPermissionForRole(profile.permission, ctx.pairedUserId, ctx.targetFolder);
  } catch (err) {
    log.error('scenario-pairing: grantPermissionForRole failed', {
      role,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Scenario member paired', { role, name, folder: ctx.targetFolder });

  // 3. Greeting (suppress the channel's generic "Pairing success!").
  return { confirmation: profile.greeting(name), suppressDefaultConfirmation: true };
}

registerPairConsumer(scenarioPairConsumer);
