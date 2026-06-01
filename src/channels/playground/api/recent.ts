/**
 * GET /api/drafts/:folder/recent — recent chat-kind messages for the
 * agent group bound to this draft folder. Used by chat.js on mount
 * and on SSE reconnect to fill any gap caused by a dropped EventSource
 * (the host pushes once; a missed event is gone forever otherwise).
 *
 * Scans every active session for the agent group, gathers the last N
 * chat-kind rows across all of them, sorts by timestamp, and returns
 * the most recent slice. Keeping it small (default 20) bounds the
 * payload while comfortably covering the typical reconnect gap.
 */
import fs from 'fs';

import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { getActiveSessions } from '../../../db/sessions.js';
import { outboundDbPath } from '../../../session-manager.js';
import { openOutboundDb } from '../../../db/session-db.js';
import type { ApiResult } from './me.js';

export interface RecentMessage {
  id: string;
  seq: number;
  timestamp: string;
  kind: string;
  content: unknown;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function handleGetRecent(
  draftFolder: string,
  options: { limit?: number; sinceSeq?: number } = {},
): ApiResult<{ messages: RecentMessage[] }> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT));
  const sinceSeq = Math.max(0, options.sinceSeq ?? 0);
  const group = getAgentGroupByFolder(draftFolder);
  if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };

  const all: RecentMessage[] = [];
  for (const session of getActiveSessions().filter((s) => s.agent_group_id === group.id)) {
    const dbPath = outboundDbPath(group.id, session.id);
    if (!fs.existsSync(dbPath)) continue;
    const db = openOutboundDb(dbPath);
    try {
      const rows = db
        .prepare(
          `SELECT id, seq, timestamp, kind, content, provider, model, tokens_in, tokens_out, latency_ms
           FROM messages_out
           WHERE kind = 'chat' AND seq > ?
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(sinceSeq, limit) as Array<{
        id: string;
        seq: number;
        timestamp: string;
        kind: string;
        content: string;
        provider: string | null;
        model: string | null;
        tokens_in: number | null;
        tokens_out: number | null;
        latency_ms: number | null;
      }>;
      for (const r of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.content);
        } catch {
          parsed = { text: r.content };
        }
        all.push({
          id: r.id,
          seq: r.seq,
          timestamp: r.timestamp,
          kind: r.kind,
          content: parsed,
          provider: r.provider,
          model: r.model,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
          latencyMs: r.latency_ms,
        });
      }
    } finally {
      db.close();
    }
  }

  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { status: 200, body: { messages: all.slice(-limit) } };
}
