import { getDb } from '../db/connection.js';

/**
 * The user who owns a playground agent group — the department entity model's
 * answer to "whose credentials should this group's requests use". A provisioned
 * group (see provisionUser) has exactly one member; if there are several, the
 * earliest-added wins. Returns null for a memberless or unknown group.
 */
export function userIdForAgentGroup(agentGroupId: string): string | null {
  const row = getDb()
    .prepare(`SELECT user_id FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at ASC LIMIT 1`)
    .get(agentGroupId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}
