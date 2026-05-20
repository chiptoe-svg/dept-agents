/**
 * Class feature — instructor pair consumer.
 *
 * When the wire-to target is an instructor folder (`instructor_*`),
 * this consumer:
 *   1. Stamps class metadata on the agent group (name, email,
 *      paired user_id) — useful for Drive sharing + git authorship.
 *   2. Grants global `admin` to the paired user. Multiple instructors
 *      supported; each one gets independent admin. (Owner promotion
 *      still happens in the Telegram pair handler when the instance
 *      has no owner yet — that's the existing flow, untouched.)
 *   3. Sends a short greeting.
 *
 * Returns `{}` for non-instructor flows so the channel falls through
 * to the default confirmation.
 */
import { classRoleForFolder, findClassInstructor } from './class-config.js';
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { setAgentGroupMetadataKey } from './db/agent-groups.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { log } from './log.js';

async function classPairInstructor(ctx: PairContext): Promise<PairResult> {
  if (classRoleForFolder(ctx.targetFolder) !== 'instructor') return {};
  const instructor = findClassInstructor(ctx.targetFolder);
  if (!instructor) return {}; // defensive

  // 1. Stamp metadata
  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', instructor.name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  // 2. Grant global admin (idempotent — re-pair is safe).
  try {
    grantRole({
      user_id: ctx.pairedUserId,
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error('class-pair-instructor: grantRole failed', {
      name: instructor.name,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Class instructor paired', { name: instructor.name, folder: ctx.targetFolder });

  return {
    confirmation:
      `Hi ${instructor.name}! You're set up as an instructor for this class. ` +
      `You have global admin — read every student's transcripts, edit shared CLAUDE.md, manage TAs. Send /playground to customize this agent's persona.`,
    suppressDefaultConfirmation: true,
  };
}

registerPairConsumer(classPairInstructor);
