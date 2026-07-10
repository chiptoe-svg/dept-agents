/**
 * Records when an agent group's LLM requests fall back to the department
 * backstop credential, so the operator can see who is running on the
 * shared department key vs. their own connected account.
 *
 * Installed as the trunk recordBackstop hook (see
 * setBackstopRecorder in src/user-provider-resolver.ts), called from
 * resolveUserCreds on every request that has no usable per-user
 * credential — i.e. potentially on every proxied LLM call for that group.
 *
 * Debounced to at most one DB write per group per 60s, regardless of
 * provider: recordBackstopUse reads the group's existing row first and
 * skips the write whenever it was updated more recently than the
 * debounce window — even if the incoming providerId differs from the
 * stored one. A single group's traffic can alternate between routes
 * within a window (e.g. primary turn on one provider + an MCP tool
 * call proxied through another), so keying the debounce per-provider
 * would turn every provider switch into a write and reproduce the
 * hot-path DB-write storm this debounce exists to prevent. When a
 * write does happen (no existing row, or the window elapsed), it
 * upserts the latest providerId so the stored value reflects the most
 * recent backstop provider. This is read-then-conditional-write rather
 * than an in-memory Map, so it self-resets with the DB (no separate
 * module-level state to leak across process lifetimes or tests).
 */
import { getDb } from './db/connection.js';

const DEBOUNCE_MS = 60_000;

export interface BackstopUse {
  providerId: string;
  at: string;
}

export function recordBackstopUse(agentGroupId: string, providerId: string): void {
  const existing = getBackstopUse(agentGroupId);
  if (existing) {
    const lastMs = Date.parse(existing.at);
    if (!Number.isNaN(lastMs) && Date.now() - lastMs < DEBOUNCE_MS) {
      return; // debounced — this group wrote recently, regardless of provider
    }
  }
  getDb()
    .prepare(
      `INSERT INTO backstop_usage (agent_group_id, provider_id, at)
       VALUES (@agentGroupId, @providerId, @at)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         at          = excluded.at`,
    )
    .run({ agentGroupId, providerId, at: new Date().toISOString() });
}

export function getBackstopUse(agentGroupId: string): BackstopUse | null {
  const row = getDb()
    .prepare('SELECT provider_id AS providerId, at FROM backstop_usage WHERE agent_group_id = ?')
    .get(agentGroupId) as BackstopUse | undefined;
  return row ?? null;
}
