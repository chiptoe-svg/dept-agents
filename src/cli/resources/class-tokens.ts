import { getDb } from '../../db/connection.js';
import {
  issueClassLoginToken,
  listTokensForUser,
  revokeAllForUser,
  rotateClassLoginToken,
} from '../../class-login-tokens.js';
import { registerResource } from '../crud.js';
import { readEnvFile } from '../../env.js';

function resolveUserIdByEmail(email: string): string | null {
  const row = getDb().prepare('SELECT user_id FROM classroom_roster WHERE email = ?').get(email) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}

/**
 * Fallback lookup for users provisioned via `ncl users provision`, which
 * stores the email in agent_groups.metadata ({"email":"..."}) and writes NO
 * classroom_roster row. Resolves the group whose metadata email matches
 * (case-insensitive), then that group's member user_id — or, failing that,
 * a user with a role scoped to that group.
 */
function resolveUserIdByMetadataEmail(email: string): string | null {
  const group = getDb()
    .prepare("SELECT id FROM agent_groups WHERE LOWER(json_extract(metadata, '$.email')) = LOWER(?)")
    .get(email) as { id: string } | undefined;
  if (!group) return null;
  const member = getDb()
    .prepare('SELECT user_id FROM agent_group_members WHERE agent_group_id = ? LIMIT 1')
    .get(group.id) as { user_id: string } | undefined;
  if (member) return member.user_id;
  const scopedRole = getDb()
    .prepare('SELECT user_id FROM user_roles WHERE agent_group_id = ? LIMIT 1')
    .get(group.id) as { user_id: string } | undefined;
  return scopedRole?.user_id ?? null;
}

/**
 * Resolve the target user for issue/rotate/revoke. Two paths:
 *   - `--user-id <id>` — direct; bypasses roster/metadata entirely. Validated
 *     against the users table so a typo can't mint a live login token for a
 *     nonexistent identity.
 *   - `--email <email>` — classroom_roster first (classroom flow), then
 *     agent_groups metadata (department `users provision` flow).
 */
function resolveTokenUser(args: Record<string, unknown>): { userId: string; email: string | null } {
  const userIdArg = args.user_id as string | undefined;
  const email = (args.email as string | undefined) ?? null;
  if (userIdArg) {
    const row = getDb().prepare('SELECT id FROM users WHERE id = ?').get(userIdArg);
    if (!row) throw new Error(`No user with id ${userIdArg}`);
    return { userId: userIdArg, email };
  }
  if (!email) throw new Error('--user-id or --email is required');
  const userId = resolveUserIdByEmail(email) ?? resolveUserIdByMetadataEmail(email);
  if (!userId) {
    throw new Error(`No user found for email ${email} (checked classroom_roster and agent_groups metadata)`);
  }
  return { userId, email };
}

function publicPlaygroundBaseUrl(): string {
  const url = process.env.PUBLIC_PLAYGROUND_URL || readEnvFile(['PUBLIC_PLAYGROUND_URL']).PUBLIC_PLAYGROUND_URL;
  return (url || 'http://localhost:3002').replace(/\/+$/, '');
}

function urlFor(token: string): string {
  return `${publicPlaygroundBaseUrl()}/?token=${token}`;
}

registerResource({
  name: 'class-token',
  plural: 'class-tokens',
  table: 'class_login_tokens',
  description:
    'Class login token — durable per-roster URL token a student bookmarks to log into the playground without Google OAuth. One row per token; multiple non-revoked rows per user are allowed (any active one redeems). Instructor mints + distributes the URLs via their normal channel (Drive doc, class portal, email blast).',
  idColumn: 'token',
  // Not enumerated in the task brief (a classroom-only resource), but it
  // needs a verdict too: no agent-group column, and rows are bearer login
  // tokens for the playground — an even more severe leak than an id if
  // exposed cross-tenant. Fully blocked for agent callers.
  scopeColumn: null,
  columns: [
    { name: 'token', type: 'string', description: 'The opaque token string embedded in the student URL.' },
    { name: 'user_id', type: 'string', description: 'The roster user this token authenticates as.' },
    { name: 'created_at', type: 'string', description: 'ISO timestamp when the token was issued.' },
    {
      name: 'revoked_at',
      type: 'string',
      description: 'ISO timestamp when the token was rotated/revoked; NULL while active.',
    },
  ],
  operations: { list: 'open' },
  customOperations: {
    issue: {
      access: 'approval',
      description:
        'Mint a new login token for a user (without revoking existing ones). Use --user-id <id> (direct) or --email <email> (resolved via classroom_roster, then agent_groups metadata for provisioned users). Prints the URL to distribute.',
      handler: async (args) => {
        const { userId, email } = resolveTokenUser(args);
        const token = issueClassLoginToken(userId);
        return { ok: true, email, user_id: userId, url: urlFor(token) };
      },
    },
    rotate: {
      access: 'approval',
      description:
        "Revoke all active tokens for a user and issue a fresh one. Use --user-id <id> (direct) or --email <email> (roster, then provisioned-user metadata). Prints the new URL. The user's previous URL stops working immediately.",
      handler: async (args) => {
        const { userId, email } = resolveTokenUser(args);
        const token = rotateClassLoginToken(userId);
        return { ok: true, email, user_id: userId, url: urlFor(token) };
      },
    },
    revoke: {
      access: 'approval',
      description:
        'Revoke all active tokens for a user without issuing a new one. Use --user-id <id> (direct) or --email <email> (roster, then provisioned-user metadata). The user can no longer log in until you issue a fresh token.',
      handler: async (args) => {
        const { userId, email } = resolveTokenUser(args);
        const revoked = revokeAllForUser(userId);
        return { ok: true, email, user_id: userId, revoked };
      },
    },
    'list-for': {
      access: 'open',
      description: 'Show every token (active and revoked) for one roster user. Use --email <student-email>.',
      handler: async (args, ctx) => {
        // Custom operation, not routed through genericList — needs its own
        // guard. Bearer login tokens, so no agent caller gets any, same as
        // the resource's `list` (scopeColumn: null above).
        if (ctx.caller === 'agent' && ctx.cliScope !== 'all') {
          throw new Error('list-for is not available to agent callers');
        }
        const email = args.email as string;
        if (!email) throw new Error('--email is required');
        const userId = resolveUserIdByEmail(email);
        if (!userId) throw new Error(`No roster entry for email ${email}`);
        return { ok: true, email, user_id: userId, tokens: listTokensForUser(userId) };
      },
    },
  },
});
