import { getPlaygroundAgentForUser, setAgentGroupMetadataKey } from '../../../db/agent-groups.js';
import { lookupRosterByUserId } from '../../../db/classroom-roster.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { clearStudentCredentials, hasStudentCredentials } from '../../../student-google-auth.js';
import { revokeSession, revokeSessionsForUser } from '../auth-store.js';
import type { PlaygroundSession } from '../auth-store.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface MyAgentResponse {
  user: { id: string | null; role: 'owner' | 'admin' | 'member' };
  agent: { id: string; name: string; folder: string };
}

function resolveRole(userId: string | null): 'owner' | 'admin' | 'member' {
  if (!userId) return 'member';
  if (isOwner(userId)) return 'owner';
  if (isGlobalAdmin(userId)) return 'admin';
  return 'member';
}

export function handleGetMyAgent(session: PlaygroundSession): ApiResult<MyAgentResponse> {
  const agent = getPlaygroundAgentForUser(session.userId);
  if (!agent) return { status: 404, body: { error: 'no agent group available' } };
  return {
    status: 200,
    body: {
      user: { id: session.userId, role: resolveRole(session.userId) },
      agent: { id: agent.id, name: agent.name, folder: agent.folder },
    },
  };
}

export interface GoogleStatusResponse {
  connected: boolean;
  email: string | null;
}

export function handleGetGoogleStatus(session: PlaygroundSession): ApiResult<GoogleStatusResponse> {
  const userId = session.userId;
  if (!userId) return { status: 401, body: { error: 'not signed in' } };
  const connected = hasStudentCredentials(userId);
  const email = lookupRosterByUserId(userId)?.email ?? null;
  return { status: 200, body: { connected, email } };
}

export function handleGoogleDisconnect(session: PlaygroundSession): ApiResult<{ ok: true }> {
  const userId = session.userId;
  if (!userId) return { status: 401, body: { error: 'not signed in' } };
  clearStudentCredentials(userId);
  const rosterEntry = lookupRosterByUserId(userId);
  if (rosterEntry?.agent_group_id) {
    setAgentGroupMetadataKey(rosterEntry.agent_group_id, 'student_user_id', null);
  }
  return { status: 200, body: { ok: true } };
}

export function handleLogout(session: PlaygroundSession): ApiResult<{ ok: true }> {
  revokeSession(session.cookieValue, 'user-logout');
  return { status: 200, body: { ok: true } };
}

export function handleLogoutAll(session: PlaygroundSession): ApiResult<{ ok: true; revoked: number }> {
  if (!session.userId) {
    revokeSession(session.cookieValue, 'user-logout');
    return { status: 200, body: { ok: true, revoked: 1 } };
  }
  const revoked = revokeSessionsForUser(session.userId);
  return { status: 200, body: { ok: true, revoked } };
}
