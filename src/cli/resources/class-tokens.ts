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
        'Mint a new login token for a roster user (without revoking existing ones). Use --email <student-email>. Prints the URL to distribute.',
      handler: async (args) => {
        const email = args.email as string;
        if (!email) throw new Error('--email is required');
        const userId = resolveUserIdByEmail(email);
        if (!userId) throw new Error(`No roster entry for email ${email}`);
        const token = issueClassLoginToken(userId);
        return { ok: true, email, user_id: userId, url: urlFor(token) };
      },
    },
    rotate: {
      access: 'approval',
      description:
        "Revoke all active tokens for a user and issue a fresh one. Use --email <student-email>. Prints the new URL. The student's previous URL stops working immediately.",
      handler: async (args) => {
        const email = args.email as string;
        if (!email) throw new Error('--email is required');
        const userId = resolveUserIdByEmail(email);
        if (!userId) throw new Error(`No roster entry for email ${email}`);
        const token = rotateClassLoginToken(userId);
        return { ok: true, email, user_id: userId, url: urlFor(token) };
      },
    },
    revoke: {
      access: 'approval',
      description:
        'Revoke all active tokens for a user without issuing a new one. Use --email <student-email>. The student can no longer log in until you issue a fresh token.',
      handler: async (args) => {
        const email = args.email as string;
        if (!email) throw new Error('--email is required');
        const userId = resolveUserIdByEmail(email);
        if (!userId) throw new Error(`No roster entry for email ${email}`);
        const revoked = revokeAllForUser(userId);
        return { ok: true, email, user_id: userId, revoked };
      },
    },
    'list-for': {
      access: 'open',
      description: 'Show every token (active and revoked) for one roster user. Use --email <student-email>.',
      handler: async (args) => {
        const email = args.email as string;
        if (!email) throw new Error('--email is required');
        const userId = resolveUserIdByEmail(email);
        if (!userId) throw new Error(`No roster entry for email ${email}`);
        return { ok: true, email, user_id: userId, tokens: listTokensForUser(userId) };
      },
    },
  },
});
