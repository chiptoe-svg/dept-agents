/**
 * Class feature — playground draft-mutation gate.
 *
 * Locks the three mutate endpoints (file PUT, skills PUT, provider
 * PUT) for class drafts based on the requesting user's role:
 *
 *   - Members only (students editing their own draft) → 403. They
 *     can still use the persona endpoint to edit CLAUDE.local.md.
 *   - Admin scope on the target agent group (TAs assigned via
 *     scoped admin, instructors with global admin) → allow.
 *   - Non-class drafts (no such student/ta/instructor folder) →
 *     allow (gate is class-specific only).
 *
 * The gate reads `ctx.userId` (Phase 12.1's playground extension)
 * and uses the existing `canAccessAgentGroup` permission primitive.
 * If `userId` is unset (legacy 2-arg call site that didn't supply
 * one), we fall back to the conservative "lock down all class
 * drafts" behavior — same as Phase 5/10.3's pre-role implementation.
 */
import { targetFolderOf } from './agent-builder/core.js';
import {
  registerDraftMutationGate,
  type DraftMutationContext,
  type DraftMutationDecision,
} from './channels/playground-gate-registry.js';
import { isClassStudentFolder } from './class-config.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { canAccessAgentGroup } from './modules/permissions/access.js';

const STUDENT_LOCKED_MESSAGE =
  'Class-student drafts only allow persona edits. Use the persona pane to edit CLAUDE.local.md.';

/**
 * True when the draft's target is in the class config — covers
 * student_*, ta_*, instructor_* folders. (Phase 12 extends
 * `isClassStudentFolder` to recognize all three role folders, not
 * just students. Until that lands, this only matches student_*.)
 */
function isClassDraft(draftFolder: string): boolean {
  try {
    return isClassStudentFolder(targetFolderOf(draftFolder));
  } catch {
    return false; // not a draft folder
  }
}

function decideClassDraftAccess(ctx: DraftMutationContext): DraftMutationDecision {
  if (!isClassDraft(ctx.draftFolder)) return { allow: true };

  // No user identity on the request — fall back to the conservative
  // lockdown so an anonymous session can't bypass restrictions.
  if (!ctx.userId) {
    return { allow: false, reason: STUDENT_LOCKED_MESSAGE };
  }

  const targetFolder = targetFolderOf(ctx.draftFolder);
  const target = getAgentGroupByFolder(targetFolder);
  if (!target) {
    // Defensive: target should exist since the draft is keyed off it.
    return { allow: false, reason: STUDENT_LOCKED_MESSAGE };
  }

  const decision = canAccessAgentGroup(ctx.userId, target.id);
  if (!decision.allowed) {
    return { allow: false, reason: STUDENT_LOCKED_MESSAGE };
  }

  // Admin scope (owner / global_admin / admin_of_group) bypasses the
  // lockdown — TAs and instructors freely edit student drafts. Plain
  // members (the student themselves) still hit the lockdown.
  if (decision.reason === 'member') {
    return { allow: false, reason: STUDENT_LOCKED_MESSAGE };
  }

  return { allow: true };
}

registerDraftMutationGate(decideClassDraftAccess);
