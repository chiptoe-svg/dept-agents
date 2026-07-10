/**
 * Authorization for folder-addressed playground routes.
 *
 * Every `/api/drafts/:folder/...` route takes its target from the URL, so
 * without a per-request check any authenticated user can address any other
 * user's agent group. This is that check, and it is the ONLY thing routes
 * should use to authorize a mutation.
 *
 * Deliberately different from `canReadDraft`:
 *   - unknown folder → DENY (a write would materialize it)
 *   - PLAYGROUND_AUTH_BYPASS → still enforced (bypass authenticates a seat;
 *     it must never authorize one user to act on another's group)
 *
 * Do NOT use `checkDraftMutation` for authorization. It is a class-lockdown
 * hook that default-allows with an empty gate chain.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';

/** `null` when allowed; a short reason string when denied. */
export function requireGroupAccess(folder: string, userId: string | null | undefined): string | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return 'unknown_group';
  if (!userId) return 'no_session';
  const decision = canAccessAgentGroup(userId, group.id);
  return decision.allowed ? null : decision.reason;
}
