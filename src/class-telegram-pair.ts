/**
 * Student-side Telegram pairing for the classroom feature.
 *
 * Flow:
 *   1. Student in the playground (logged in as `class:student_NN`) clicks
 *      "Connect Telegram" → playground calls POST /api/me/telegram/pair-code.
 *   2. `issuePairCode(userId)` mints a short alphanumeric code, stores it
 *      in `class_telegram_pair_codes` with a 15-min TTL, returns the code.
 *   3. Student DMs `@<BotUsername> /pair-class <code>` from their own
 *      Telegram account.
 *   4. The Telegram bot intercepts that message (see telegram.ts) and
 *      calls `consumePairCode(code, telegramUserId, telegramHandle)`.
 *   5. On a successful consume, this module:
 *        - upserts the Telegram user row
 *        - resolves the student's agent_group from their web user_id
 *        - resolves the Telegram DM messaging_group (or auto-creates it)
 *        - wires the messaging_group → agent_group (createMessagingGroupAgent),
 *          which also auto-creates the agent_destinations row so the bot
 *          can DM back into that chat
 *        - inserts an agent_group_members row so the agent group's access
 *          gate accepts the student's Telegram user.
 *   6. Playground polls /api/me/telegram (or student refreshes Settings)
 *      and now sees "Connected as @<handle> via Telegram".
 *
 * Trust model: pair codes are short (10 chars, ~10^16 keyspace), single-use,
 * 15-min TTL. The "what you have" factor is the playground session cookie
 * (which proves the student already authenticated with email-PIN). Sharing
 * the code with someone else lets that person pair THEIR Telegram to YOUR
 * web account — same risk surface as sharing your bookmark URL after
 * passing the PIN gate.
 */
import crypto from 'crypto';

import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { getDb } from './db/connection.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { addMember, hasMembershipRow } from './modules/permissions/db/agent-group-members.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { registerTelegramCommand } from './channels/telegram-commands.js';
import { log } from './log.js';

const CODE_LEN = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — copy-paste friendly
const PAIR_CODE_TTL_MS = 15 * 60 * 1000;

interface PairCodeRow {
  code: string;
  web_user_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  telegram_user_id: string | null;
  telegram_handle: string | null;
}

function generateCode(): string {
  const buf = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/** Mint a fresh pair code for the given web user. Revokes any prior active
 * code for that user so only one is outstanding at a time (predictable UX
 * when the student clicks the button twice). */
export function issuePairCode(webUserId: string): { code: string; expiresAt: number } {
  const db = getDb();
  // Drop any prior unconsumed-and-still-valid code for this user — at most
  // one outstanding code per user.
  db.prepare(
    `UPDATE class_telegram_pair_codes
     SET expires_at = ?
     WHERE web_user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).run(Date.now(), webUserId, Date.now());

  const now = Date.now();
  const code = generateCode();
  const expiresAt = now + PAIR_CODE_TTL_MS;
  db.prepare(
    `INSERT INTO class_telegram_pair_codes (code, web_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(code, webUserId, now, expiresAt);
  log.info('Class telegram pair code issued', { webUserId, expiresAt: new Date(expiresAt).toISOString() });
  return { code, expiresAt };
}

/**
 * Consume a pair code via Telegram. Called from the bot when a student
 * sends `/pair-class <code>` in a DM.
 *
 * Returns:
 *   - { ok: true, webUserId } on success (caller can build a confirmation
 *     reply with the user's name / agent identity)
 *   - { ok: false, reason } on failure (unknown code, expired, already used)
 */
export type ConsumePairResult =
  | { ok: true; webUserId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'already-used' };

export function consumePairCode(code: string, telegramUserId: string, telegramHandle: string): ConsumePairResult {
  const db = getDb();
  const row = db.prepare('SELECT * FROM class_telegram_pair_codes WHERE code = ?').get(code) as PairCodeRow | undefined;

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumed_at !== null) return { ok: false, reason: 'already-used' };
  if (Date.now() > row.expires_at) return { ok: false, reason: 'expired' };

  db.prepare(
    `UPDATE class_telegram_pair_codes
     SET consumed_at = ?, telegram_user_id = ?, telegram_handle = ?
     WHERE code = ?`,
  ).run(Date.now(), telegramUserId, telegramHandle, code);

  // Wire the student's Telegram DM to their student agent group so
  // DMs from their phone route to the same agent they use on the web.
  applyPairing(row.web_user_id, telegramUserId, telegramHandle);
  return { ok: true, webUserId: row.web_user_id };
}

/**
 * Side-effects after a successful pair-code consume:
 *  1. Upsert the Telegram user row (display name = handle).
 *  2. Look up the student's agent group via the `class:<folder>` convention.
 *  3. Get or create the Telegram DM messaging group for this chat.
 *  4. Wire the messaging group → agent group (idempotent on re-pair).
 *  5. Add an agent_group_members row so the student's Telegram user is
 *     recognized as an unprivileged member.
 *
 * Each step is fault-tolerant — we log + continue rather than rolling
 * back, since the pair-code consume is already committed. Worst case
 * the student's pairing is recorded but routing isn't wired; they can
 * re-issue and retry.
 */
function applyPairing(webUserId: string, telegramUserId: string, telegramHandle: string): void {
  try {
    // Web user_id convention is `class:<folder>` — see scripts/class-skeleton.ts
    // and scripts/classroom-roster-sheet.ts.
    const folder = webUserId.startsWith('class:') ? webUserId.slice('class:'.length) : null;
    if (!folder) {
      log.warn('Class telegram pair: web user_id not in class:<folder> form', { webUserId });
      return;
    }
    const agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) {
      log.warn('Class telegram pair: no agent group for folder', { folder, webUserId });
      return;
    }

    upsertUser({
      id: telegramUserId,
      kind: 'telegram',
      display_name: telegramHandle,
      created_at: new Date().toISOString(),
    });

    let mg = getMessagingGroupByPlatform('telegram', telegramUserId);
    if (!mg) {
      const fresh = {
        id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel_type: 'telegram',
        platform_id: telegramUserId,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'request_approval' as const,
        created_at: new Date().toISOString(),
      };
      createMessagingGroup(fresh);
      mg = fresh;
    }

    // Wire the DM → agent. Skip if already wired (idempotent re-pair).
    // engage_pattern '.' is the "match every message" sentinel since
    // engage_mode 'pattern' is the always-route mode for DMs.
    const wiringExists = getDb()
      .prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
      .get(mg.id, agentGroup.id);
    if (!wiringExists) {
      createMessagingGroupAgent({
        id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        messaging_group_id: mg.id,
        agent_group_id: agentGroup.id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: new Date().toISOString(),
      });
    }

    if (!hasMembershipRow(telegramUserId, agentGroup.id)) {
      addMember({
        user_id: telegramUserId,
        agent_group_id: agentGroup.id,
        added_by: webUserId,
        added_at: new Date().toISOString(),
      });
    }

    log.info('Class telegram pairing applied', {
      webUserId,
      telegramUserId,
      agentGroupId: agentGroup.id,
      folder,
    });
  } catch (err) {
    log.error('Class telegram pair: applyPairing threw', { err, webUserId, telegramUserId });
  }
}

async function sendTelegramReply(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId.replace(/^telegram:/, ''), text }),
    });
  } catch (err) {
    log.warn('class-telegram-pair: reply send threw', { chatId, err });
  }
}

// /pair-class <CODE> — student sends from their own Telegram account to
// link it to their playground session. The reply confirms (or surfaces
// the failure reason) so they know whether to retry.
registerTelegramCommand('/pair-class', async (ctx) => {
  const match = ctx.text.match(/^\/pair-class(?:@\S+)?\s+([A-Z0-9]+)/i);
  if (!match) {
    await sendTelegramReply(
      ctx.token,
      ctx.platformId,
      'Usage: /pair-class CODE — open the playground in your browser → Settings → Connect Telegram for the code.',
    );
    return true;
  }
  const code = match[1]!.toUpperCase();
  const tgUserId = ctx.authorUserId || ctx.platformId;
  const tgHandle = tgUserId; // No display name in the command context yet; use the user_id as the label.
  const result = consumePairCode(code, tgUserId, tgHandle);
  if (!result.ok) {
    const reason =
      result.reason === 'unknown'
        ? 'Code not recognized. Open the playground → Settings → Connect Telegram to mint a fresh one.'
        : result.reason === 'expired'
          ? 'That code expired (15-minute TTL). Open the playground → Settings → Connect Telegram for a fresh one.'
          : 'That code was already used. If this is a different device, mint a fresh one from the playground.';
    await sendTelegramReply(ctx.token, ctx.platformId, reason);
    return true;
  }
  await sendTelegramReply(
    ctx.token,
    ctx.platformId,
    `Paired! You're now connected to your class agent. DM me here anytime to chat with it — same agent as the playground.`,
  );
  return true;
});

/** Look up an active pairing for a web user — used by the playground UI to
 * show "Connected as @handle" vs "Connect Telegram". */
export function getTelegramPairingFor(webUserId: string): { telegramUserId: string; telegramHandle: string } | null {
  const row = getDb()
    .prepare(
      `SELECT telegram_user_id, telegram_handle
       FROM class_telegram_pair_codes
       WHERE web_user_id = ? AND consumed_at IS NOT NULL
       ORDER BY consumed_at DESC LIMIT 1`,
    )
    .get(webUserId) as { telegram_user_id: string; telegram_handle: string } | undefined;
  if (!row) return null;
  return { telegramUserId: row.telegram_user_id, telegramHandle: row.telegram_handle };
}
