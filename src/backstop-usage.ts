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
 * Debounced to at most one DB write per group per 60s *for the same
 * provider*: recordBackstopUse reads the group's existing row first and
 * skips the write only when the incoming providerId matches the stored
 * one and it was updated more recently than the debounce window. A
 * provider change always writes immediately — that's a meaningfully new
 * event for the operator (e.g. the group's requests started hitting a
 * different backstop provider), not repeat noise from the same hot-path
 * call. This is read-then-conditional-write rather than an in-memory
 * Map, so it self-resets with the DB (no separate module-level state to
 * leak across process lifetimes or tests).
 */
import { getDb } from './db/connection.js';

const DEBOUNCE_MS = 60_000;

export interface BackstopUse {
  providerId: string;
  at: string;
}

export function recordBackstopUse(agentGroupId: string, providerId: string): void {
  const existing = getBackstopUse(agentGroupId);
  if (existing && existing.providerId === providerId) {
    const lastMs = Date.parse(existing.at);
    if (!Number.isNaN(lastMs) && Date.now() - lastMs < DEBOUNCE_MS) {
      return; // debounced — same provider recorded recently within the window
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
