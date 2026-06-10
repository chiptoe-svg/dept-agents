/**
 * Owner-gated API handlers for the default-participant template.
 *
 * Three endpoints:
 *   GET  /api/default-participant        — status (saved, templateFolder, participantCount)
 *   POST /api/default-participant/save   — snapshot current template into the slot
 *   POST /api/default-participant/apply-all — apply slot to every user-role agent group
 */
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import {
  applyDefaultToAllParticipants,
  ensureTemplateAgent,
  saveDefaultFromTemplate,
  TEMPLATE_FOLDER,
} from '../../../default-participant.js';
import { readSlotMeta, slotExists } from '../../../default-participant-slot.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { roleForFolder } from '../../../scenarios/registry.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './enrollment.js';

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

// ── GET /api/default-participant ──────────────────────────────────────────

export interface GetDefaultParticipantResponse {
  saved: boolean;
  savedAt: string | null;
  savedBy: string | null;
  templateFolder: string;
  templateGroupId: string;
  participantCount: number;
}

export function handleGetDefaultParticipant(session: PlaygroundSession): ApiResult<GetDefaultParticipantResponse> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  const ag = ensureTemplateAgent();
  const meta = readSlotMeta();
  const participantCount = getAllAgentGroups().filter((g) => roleForFolder(g.folder) === 'user').length;
  return {
    status: 200,
    body: {
      saved: slotExists(),
      savedAt: meta?.savedAt ?? null,
      savedBy: meta?.savedBy ?? null,
      templateFolder: TEMPLATE_FOLDER,
      templateGroupId: ag.id,
      participantCount,
    },
  };
}

// ── POST /api/default-participant/save ────────────────────────────────────

export interface SaveDefaultParticipantResponse {
  ok: true;
  savedAt: string | null;
}

export function handleSaveDefaultParticipant(session: PlaygroundSession): ApiResult<SaveDefaultParticipantResponse> {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  saveDefaultFromTemplate(session.userId!);
  const meta = readSlotMeta();
  return { status: 200, body: { ok: true, savedAt: meta?.savedAt ?? null } };
}

// ── POST /api/default-participant/apply-all ───────────────────────────────

export interface ApplyDefaultToAllResponse {
  ok: true;
  affected: number;
  restorePoints: string[];
}

export function handleApplyDefaultToAll(
  session: PlaygroundSession,
  body: { confirm?: unknown },
): ApiResult<ApplyDefaultToAllResponse> {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  if (body?.confirm !== 'APPLY') {
    return { status: 400, body: { error: 'confirmation required — pass confirm:"APPLY"' } };
  }
  if (!slotExists()) {
    return { status: 400, body: { error: 'no default saved — call /save first' } };
  }
  const res = applyDefaultToAllParticipants();
  return { status: 200, body: { ok: true, ...res } };
}
