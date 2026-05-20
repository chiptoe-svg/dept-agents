/**
 * `ncl handoffs` resource — install-handoff CLI verbs.
 *
 * - `ncl handoffs list`          — list active + recently-exhausted handoffs
 * - `ncl handoffs create [...]`  — bundle + issue, print URL
 * - `ncl handoffs revoke --id X` — immediate revoke
 *
 * The token itself is shown ONLY at create time (embedded in the printed URL).
 * `list` shows the public id, status, expiry, and use counts — never the token.
 */
import { INSTALL_HANDOFF_PORT } from '../../config.js';
import {
  bundleHandoff,
  type BundleManifest,
} from '../../install-handoff/bundler.js';
import {
  issueHandoff,
  listHandoffs,
  revokeHandoff,
} from '../../install-handoff/store.js';
import { registerResource } from '../crud.js';

function parseTtl(input: string): number {
  // Accepts: 30m, 24h, 7d. Returns ms.
  const m = /^(\d+)\s*(m|h|d)$/i.exec(input.trim());
  if (!m) throw new Error(`invalid --ttl: ${input} (expected e.g. 30m, 24h, 7d)`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const mul = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = n * mul;
  if (ms > 7 * 86_400_000) throw new Error(`--ttl exceeds 7d max`);
  return ms;
}

function parseManifest(args: Record<string, unknown>): BundleManifest {
  const include = String(args.include ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const exclude = String(args.exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const valid = new Set(['env', 'gws', 'codex', 'claude-creds', 'groups']);
  for (const item of [...include, ...exclude]) {
    if (!valid.has(item)) throw new Error(`unknown bundle item: ${item} (valid: ${[...valid].join(', ')})`);
  }
  // Defaults: env, gws, codex on; claude-creds, groups off. Apply --include then --exclude.
  const m: BundleManifest = {
    env: !exclude.includes('env'),
    gws: !exclude.includes('gws'),
    codex: !exclude.includes('codex'),
    claudeCreds: include.includes('claude-creds'),
    groups: include.includes('groups'),
  };
  return m;
}

function resolveHostUrl(): string {
  const fromEnv = process.env.INSTALL_HANDOFF_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return `http://localhost:${INSTALL_HANDOFF_PORT}`;
}

registerResource({
  name: 'handoff',
  plural: 'handoffs',
  table: 'install_handoffs',
  description:
    'Install handoff — time-limited single-use URL bundling install state for cloning to a new machine.',
  idColumn: 'id',
  // Columns visible to `list`. Token hash deliberately excluded.
  columns: [
    { name: 'id', type: 'string', description: 'Public id, safe to log. Use with `revoke --id`.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'expires_at', type: 'string', description: 'ISO timestamp.' },
    { name: 'max_uses', type: 'number', description: 'Total downloads allowed before auto-revoke.' },
    { name: 'current_uses', type: 'number', description: 'Downloads consumed so far.' },
    { name: 'revoked_at', type: 'string', description: 'Set when exhausted or manually revoked.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create a new handoff. Flags: --ttl (default 24h), --max-uses (default 1, max 10), --include (comma list of: groups, claude-creds), --exclude (comma list of: env, gws, codex).',
      handler: async (args) => {
        const ttlMs = parseTtl((args.ttl as string) ?? '24h');
        const maxUses = Math.min(10, Math.max(1, parseInt(String(args['max-uses'] ?? '1'), 10)));
        const manifest = parseManifest(args);

        // Pre-issue we don't have a token yet — generate via the store
        // but defer file scan until after bundling. Workflow: bundle to a
        // temp-staged dir using a placeholder token, then issue with the
        // actual file list, then move/rename. Simpler: issue first with an
        // empty manifest, then bundle to data/handoffs/<token>/ and update
        // the handoff's files_json afterward. The store doesn't expose an
        // update — so instead we bundle to a token derived from a candidate
        // crypto value, then issue with the file manifest under that same
        // token. The cleanest path: generate the token in this verb.
        const crypto = await import('node:crypto');
        const token = crypto.randomBytes(16).toString('hex');

        // Bundle first (so we have the file list); pass the token directly
        // so the bundleDir matches what the server will serve.
        const bundle = bundleHandoff(token, manifest);

        // Now issue using the same token. issueHandoff currently mints its
        // own token internally — we need a variant. Workaround: monkey-issue
        // by stuffing the row directly. To keep the contract clean, we use
        // a small helper here that re-uses the store's hashing.
        const { _issueWithToken } = await import('../../install-handoff/store.js');
        const issued = _issueWithToken({
          token,
          ttlMs,
          maxUses,
          files: bundle.files,
        });

        const url = `${resolveHostUrl()}/handoff/${issued.token}/install.html`;
        return {
          id: issued.id,
          url,
          expires_at: issued.expiresAt,
          max_uses: maxUses,
          files: bundle.files.map((f) => f.name),
        };
      },
    },
    revoke: {
      access: 'approval',
      description: 'Revoke a handoff immediately. Use --id <handoff-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const ok = revokeHandoff(id);
        if (!ok) throw new Error(`handoff not found or already revoked: ${id}`);
        return { revoked: id };
      },
    },
    'list-status': {
      access: 'open',
      description: 'List handoffs with derived status (active/expired/exhausted/revoked).',
      handler: async () => {
        return listHandoffs();
      },
    },
  },
});
