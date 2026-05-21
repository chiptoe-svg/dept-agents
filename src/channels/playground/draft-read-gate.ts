/**
 * Playground draft READ gate.
 *
 * The mutation gate (`playground-gate-registry.ts`) covers PUT/DELETE.
 * The GET side needs its own check: every `/api/drafts/:folder` route
 * takes the folder straight from the URL, so without a gate any
 * authenticated playground user could read another agent group's
 * persona, skill list, or custom-skill file contents just by guessing
 * the folder name (e.g. a student fetching `student_08`'s files).
 *
 * Read access is the plain `canAccessAgentGroup` decision — owner,
 * admin, or member. That is deliberately looser than the mutation gate
 * (which locks even members of a class draft down to persona edits):
 * a student may *view* their own skills, just not change them.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';

/**
 * True when `userId` may read the draft/agent-group `folder`.
 *
 * A folder with no `agent_groups` row carries nothing on disk to
 * protect (every real group has both a row and a `groups/<folder>/`
 * dir), so it falls through as allowed rather than 404-ing flows that
 * touch not-yet-wired folders.
 */
export function canReadDraft(folder: string, userId: string | null | undefined): boolean {
  const group = getAgentGroupByFolder(folder);
  if (!group) return true;
  if (!userId) return false;
  return canAccessAgentGroup(userId, group.id).allowed;
}
