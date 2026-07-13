/**
 * Owner-gated Admin tab API: add users (dept-server provisioning), list
 * users with cost + model info, rotate/deactivate login links, dept
 * model-defaults get/put, and a cheap backstop-key health check.
 *
 * Every handler starts with the same owner gate used by
 * `api/default-participant.ts` and the `/api/admin/students/` block in
 * `api-routes.ts`: only `isOwner(session.userId)` may call these — there
 * is no admin-or-owner fallback here (unlike status/budgets), because
 * these endpoints mint credentials (login links) and change department
 * spend policy (model defaults).
 */
import { getAgentGroupMetadata, getPlaygroundAgentForUser } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { getDeptModelConfig, setDeptModelConfig, type DeptModelConfig } from '../../../db/app-config.js';
import { readEnvFile } from '../../../env.js';
import { isOwner } from '../../../modules/permissions/db/user-roles.js';
import { getAllUsers } from '../../../modules/permissions/db/users.js';
import { provisionUser } from '../../../provisioning/provision-user.js';
import { publicPlaygroundBaseUrl, revokeAllForUser, rotateClassLoginToken } from '../../../class-login-tokens.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './me.js';
import { aggregateAgentUsage } from './usage.js';

function ownerGate(session: PlaygroundSession): ApiResult<never> | null {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  return null;
}

// ── POST /api/admin/users — provision a new dept-server user ──────────────

export interface AddUserResponse {
  userId: string;
  folder: string;
  loginUrl: string;
}

export function handleAddUser(
  session: PlaygroundSession,
  body: { displayName?: unknown; email?: unknown },
): ApiResult<AddUserResponse> {
  const denied = ownerGate(session);
  if (denied) return denied;

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!displayName) return { status: 400, body: { error: 'displayName required' } };
  if (!/@clemson\.edu$/i.test(email)) {
    return { status: 400, body: { error: 'email must be a @clemson.edu address' } };
  }

  try {
    const r = provisionUser({ displayName, email });
    return { status: 200, body: { userId: r.userId, folder: r.folder, loginUrl: r.loginUrl } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}

// ── GET /api/admin/users — roster with cost + model info ──────────────────

export interface AdminUserRow {
  userId: string;
  name: string;
  email: string | null;
  folder: string;
  provider: string | null;
  model: string | null;
  privateMode: boolean;
  lastActive: string | null;
  /** Count of this user's live sessions (running or idle container). */
  session: number;
  costMtd: number;
}

export function handleListUsers(session: PlaygroundSession): ApiResult<{ users: AdminUserRow[] }> {
  const denied = ownerGate(session);
  if (denied) return denied;

  const dept = getDeptModelConfig();
  const users: AdminUserRow[] = [];
  for (const u of getAllUsers()) {
    if (u.kind !== 'playground') continue;
    const group = getPlaygroundAgentForUser(u.id);
    if (!group) continue;

    const cc = getContainerConfig(group.id);
    const meta = getAgentGroupMetadata(group.id);
    const sessions = getSessionsByAgentGroup(group.id);
    // Same lastActive derivation as api/status.ts's per-agent roll-up:
    // ISO-8601 timestamps sort lexicographically === chronologically.
    const lastActive =
      sessions
        .map((s) => s.last_active)
        .filter((v): v is string => !!v)
        .sort()
        .pop() ?? null;
    const liveSessions = sessions.filter(
      (s) => s.status === 'active' && (s.container_status === 'running' || s.container_status === 'idle'),
    ).length;

    users.push({
      userId: u.id,
      name: u.display_name ?? group.name,
      email: typeof meta.email === 'string' ? meta.email : null,
      folder: group.folder,
      provider: cc?.model_provider ?? null,
      model: cc?.model ?? null,
      privateMode: cc?.model_provider === dept.private.provider && cc?.model === dept.private.model,
      lastActive,
      session: liveSessions,
      costMtd: aggregateAgentUsage(group.id).thisMonth.costUsd,
    });
  }
  return { status: 200, body: { users } };
}

// ── POST /api/admin/users/:folder/rotate-link ──────────────────────────────

export function handleRotateLink(session: PlaygroundSession, userId: string): ApiResult<{ loginUrl: string }> {
  const denied = ownerGate(session);
  if (denied) return denied;

  const token = rotateClassLoginToken(userId);
  return { status: 200, body: { loginUrl: `${publicPlaygroundBaseUrl()}/?token=${token}` } };
}

// ── POST /api/admin/users/:folder/deactivate ───────────────────────────────

export function handleDeactivateUser(session: PlaygroundSession, userId: string): ApiResult<{ ok: true }> {
  const denied = ownerGate(session);
  if (denied) return denied;

  revokeAllForUser(userId);
  return { status: 200, body: { ok: true } };
}

// ── GET/PUT /api/admin/model-defaults ──────────────────────────────────────

export function handleGetModelDefaults(session: PlaygroundSession): ApiResult<DeptModelConfig> {
  const denied = ownerGate(session);
  if (denied) return denied;

  return { status: 200, body: getDeptModelConfig() };
}

function isModelSpec(v: unknown): v is { model: string; provider: string } {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { model?: unknown }).model === 'string' &&
    typeof (v as { provider?: unknown }).provider === 'string'
  );
}

export function handlePutModelDefaults(
  session: PlaygroundSession,
  body: { defaultCloud?: unknown; private?: unknown },
): ApiResult<{ ok: true }> {
  const denied = ownerGate(session);
  if (denied) return denied;

  if (!isModelSpec(body.defaultCloud) || !isModelSpec(body.private)) {
    return { status: 400, body: { error: 'defaultCloud and private ({model, provider}) required' } };
  }
  setDeptModelConfig({ defaultCloud: body.defaultCloud, private: body.private });
  return { status: 200, body: { ok: true } };
}

// ── GET /api/admin/backstop-health ─────────────────────────────────────────

export interface BackstopHealthResponse {
  keyPresent: boolean;
  spendMtd: number;
}

export function handleBackstopHealth(session: PlaygroundSession): ApiResult<BackstopHealthResponse> {
  const denied = ownerGate(session);
  if (denied) return denied;

  // Same env read the credential proxy uses (src/credential-proxy.ts) —
  // presence only, never a paid probe call.
  const env = readEnvFile(['OPENAI_API_KEY']);
  const keyPresent = !!env.OPENAI_API_KEY;

  let spendMtd = 0;
  for (const u of getAllUsers()) {
    if (u.kind !== 'playground') continue;
    const group = getPlaygroundAgentForUser(u.id);
    if (!group) continue;
    spendMtd += aggregateAgentUsage(group.id).thisMonth.costUsd;
  }

  return { status: 200, body: { keyPresent, spendMtd } };
}
