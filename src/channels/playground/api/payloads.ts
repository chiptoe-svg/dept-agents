import fs from 'fs';
import path from 'path';
import { openStore } from '../../../proxy-payload-log/store.js';
import { parseSections, type Sections } from '../../../proxy-payload-log/sections.js';
import type { ApiResult } from './me.js';

export interface PayloadRowOut {
  seq: number;
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  requestBytes: number;
  truncated: boolean;
  responseStatus: number | null;
  sections: Sections;
}

export interface PayloadListBody {
  rows: PayloadRowOut[];
}

export interface HandleInput {
  baseDir: string;
  agentGroupId: string;
  sessionId: string;
  limit: number;
  afterSeq: number;
  canAccess: (agentGroupId: string) => boolean;
}

export async function handleGetSessionPayloads(
  input: HandleInput,
): Promise<ApiResult<PayloadListBody | { error: string }>> {
  // agentGroupId and sessionId are joined into filesystem paths below.
  // Reject anything containing path-traversal characters before any
  // path operation runs. Owner/global-admin users bypass the standard
  // agent-group access check, so this is the only place this validation
  // can happen.
  const safe = /^[A-Za-z0-9_-]+$/;
  if (!safe.test(input.agentGroupId) || !safe.test(input.sessionId)) {
    return { status: 400, body: { error: 'invalid id' } };
  }

  if (!input.canAccess(input.agentGroupId)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const dbPath = path.join(input.baseDir, input.agentGroupId, `${input.sessionId}.db`);
  if (!fs.existsSync(dbPath)) {
    return { status: 404, body: { error: 'session not found' } };
  }
  const store = openStore({
    baseDir: input.baseDir,
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId,
  });
  try {
    const rows = store.list({ limit: input.limit, afterSeq: input.afterSeq });
    const out: PayloadRowOut[] = rows.map((r) => {
      let sections: Sections;
      if (r.sectionsJson) {
        sections = JSON.parse(r.sectionsJson) as Sections;
      } else {
        sections = parseSections(r.upstreamRoute, r.requestBody);
        try {
          store.patch(r.seq, { sectionsJson: JSON.stringify(sections) });
        } catch {
          /* non-fatal — the panel still got its data */
        }
      }
      return {
        seq: r.seq,
        ts: r.ts,
        upstreamRoute: r.upstreamRoute,
        upstreamPath: r.upstreamPath,
        requestBytes: r.requestBytes,
        truncated: r.truncated,
        responseStatus: r.responseStatus,
        sections,
      };
    });
    return { status: 200, body: { rows: out } };
  } finally {
    store.close();
  }
}
