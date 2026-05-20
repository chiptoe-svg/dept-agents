/**
 * Class feature — base pair consumer (greeting + metadata stamping).
 *
 * Runs after a successful wire-to pairing whose target is a
 * provisioned class student. Responsibilities:
 *   1. Stamp student_email, student_name, student_user_id on the
 *      agent group's metadata. Downstream features (Drive folder
 *      creation, per-student Codex auth, git author env injection)
 *      read these.
 *   2. Send a short welcome that suppresses the channel's generic
 *      "Pairing success!" reply. Other class skills (gws, auth)
 *      register their own consumers that send additional short
 *      messages with their respective links.
 *
 * This is the BASE consumer. The Google Workspace skill registers
 * `class-pair-drive.ts` to add the Drive folder + URL message; the
 * auth skill registers `class-pair-auth.ts` to add the auth link.
 *
 * Non-class targets (folders that aren't in `class-config.json`)
 * return `{}` so the channel sends its default confirmation.
 */
import { findClassStudent } from './class-config.js';
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { setAgentGroupMetadataKey } from './db/agent-groups.js';

async function classPairGreeting(ctx: PairContext): Promise<PairResult> {
  const student = findClassStudent(ctx.targetFolder);
  if (!student) return {}; // not a class flow — let the channel's default reply fire.

  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', student.name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  return {
    confirmation: `Hi ${student.name}! Welcome to class. Send /playground any time to customize my personality and style.`,
    suppressDefaultConfirmation: true,
  };
}

registerPairConsumer(classPairGreeting);
