/**
 * Class feature — TA pair consumer.
 *
 * When the wire-to target is a TA folder (`ta_*`), this consumer:
 *   1. Stamps class metadata on the agent group (name, email,
 *      paired user_id) — same fields students get, used for Drive
 *      sharing, git authorship, etc.
 *   2. Grants `admin` (scoped) on every `student_*` and every `ta_*`
 *      agent group in the class — whole-class TA scope.
 *   3. Sends a short greeting that reflects TA powers.
 *
 * Returns `{}` for non-TA flows so the channel falls through to the
 * default confirmation.
 */
import { classRoleForFolder, findClassTa, readClassConfig } from './class-config.js';
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { getAgentGroupByFolder, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { log } from './log.js';

async function classPairTa(ctx: PairContext): Promise<PairResult> {
  if (classRoleForFolder(ctx.targetFolder) !== 'ta') return {};
  const ta = findClassTa(ctx.targetFolder);
  if (!ta) return {}; // shouldn't happen if classRoleForFolder said 'ta', defensive

  // 1. Stamp metadata
  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', ta.name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  // 2. Grant scoped admin on every student and every other TA
  const cfg = readClassConfig();
  if (cfg) {
    for (const member of [...cfg.students, ...cfg.tas]) {
      if (member.folder === ctx.targetFolder) continue; // already wired
      const targetAg = getAgentGroupByFolder(member.folder);
      if (!targetAg) {
        log.warn('class-pair-ta: target agent group missing — skipping admin grant', {
          ta: ta.name,
          missingFolder: member.folder,
        });
        continue;
      }
      try {
        grantRole({
          user_id: ctx.pairedUserId,
          role: 'admin',
          agent_group_id: targetAg.id,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
      } catch (err) {
        // grantRole's INSERT OR IGNORE makes re-pair idempotent — a
        // throw here would be a real DB error, surface it but don't
        // fail pairing.
        log.error('class-pair-ta: grantRole failed', {
          ta: ta.name,
          targetFolder: member.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log.info('Class TA paired', { name: ta.name, folder: ctx.targetFolder });

  return {
    confirmation:
      `Hi ${ta.name}! You're set up as a TA for this class. ` +
      `You have admin access to every student's agent group — read transcripts, edit personas via /playground, DM them through the bot.`,
    suppressDefaultConfirmation: true,
  };
}

registerPairConsumer(classPairTa);
