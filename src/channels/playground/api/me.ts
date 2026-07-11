import {
  getAgentGroupByFolder,
  getPlaygroundAgentForUser,
  setAgentGroupMetadataKey,
} from '../../../db/agent-groups.js';
import { lookupRosterByUserId } from '../../../db/classroom-roster.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { getUser } from '../../../modules/permissions/db/users.js';
import { clearStudentCredentials, hasStudentCredentials } from '../../../student-google-auth.js';
import { revokeSession, revokeSessionsForUser } from '../auth-store.js';
import type { PlaygroundSession } from '../auth-store.js';
import { PLAYGROUND_AUTH_BYPASS } from '../../../config.js';
import { readSeatsConfig } from '../seats-config.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface MyAgentResponse {
  user: { id: string | null; role: 'owner' | 'admin' | 'ta' | 'member'; seatLabel?: string; displayName?: string };
  agent: { id: string; name: string; folder: string; modelProvider: string | null };
}

function getModelProvider(agentGroupId: string): string | null {
  return getContainerConfig(agentGroupId)?.model_provider ?? null;
}

function resolveRole(userId: string | null): 'owner' | 'admin' | 'member' {
  if (!userId) return 'member';
  if (isOwner(userId)) return 'owner';
  if (isGlobalAdmin(userId)) return 'admin';
  return 'member';
}

function displayNameFor(userId: string | null): string | undefined {
  if (!userId) return undefined;
  return getUser(userId)?.display_name ?? undefined;
}

export function handleGetMyAgent(session: PlaygroundSession, seatFolder?: string | null): ApiResult<MyAgentResponse> {
  if (PLAYGROUND_AUTH_BYPASS && seatFolder) {
    const sc = readSeatsConfig();
    const seat = sc.seats.find((s) => (s.slug ?? s.folder) === seatFolder);
    if (seat) {
      const group = getAgentGroupByFolder(seat.folder);
      if (group) {
        const role = seat.role ?? 'member';
        return {
          status: 200,
          body: {
            user: {
              id: role === 'owner' ? session.userId : null,
              role: role as 'owner' | 'ta' | 'member',
              seatLabel: seat.label,
            },
            // Use the seat label as the agent name so real people's names don't appear.
            agent: { id: group.id, name: seat.label, folder: group.folder, modelProvider: getModelProvider(group.id) },
          },
        };
      }
    }
  }
  // Owner may load any agent group for editing (e.g. the default-participant template) via ?seat.
  if (seatFolder && session.userId && isOwner(session.userId)) {
    const group = getAgentGroupByFolder(seatFolder);
    if (!group) return { status: 404, body: { error: 'seat agent group not found' } };
    return {
      status: 200,
      body: {
        user: { id: session.userId, role: 'owner', displayName: displayNameFor(session.userId) },
        agent: { id: group.id, name: group.name, folder: group.folder, modelProvider: getModelProvider(group.id) },
      },
    };
  }
  if (session.bypassFolder) {
    const group = getAgentGroupByFolder(session.bypassFolder);
    if (!group) return { status: 404, body: { error: 'seat agent group not found' } };
    return {
      status: 200,
      body: {
        user: {
          id: session.userId,
          role: 'owner',
          seatLabel: session.seatLabel,
          displayName: displayNameFor(session.userId),
        },
        agent: { id: group.id, name: group.name, folder: group.folder, modelProvider: getModelProvider(group.id) },
      },
    };
  }
  const agent = getPlaygroundAgentForUser(session.userId);
  if (!agent) return { status: 404, body: { error: 'no agent group available' } };
  return {
    status: 200,
    body: {
      user: { id: session.userId, role: resolveRole(session.userId), displayName: displayNameFor(session.userId) },
      agent: { id: agent.id, name: agent.name, folder: agent.folder, modelProvider: getModelProvider(agent.id) },
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
