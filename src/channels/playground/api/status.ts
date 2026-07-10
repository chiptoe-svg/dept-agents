/**
 * Owner Status/Health API: per-agent container-health roll-up + host summary.
 * Health is derived from sessions.container_status + heartbeat-file mtime
 * (NOT the outbound.db container_state table — that's tool-in-flight info).
 */
import fs from 'fs';
import path from 'path';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { PROJECT_ROOT } from '../../../config.js';
import { ABSOLUTE_CEILING_MS } from '../../../host-sweep.js';
import { getActiveContainerCount } from '../../../container-runner.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { getPlaygroundStatus } from '../server.js';
import { getAllAgentGroups, getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { heartbeatPath } from '../../../session-manager.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './me.js';

export type SessionHealth = 'running' | 'stale' | 'idle';
export type AgentHealth = SessionHealth | 'never';

/** Sentinel age for a missing heartbeat file (treated as past any ceiling). */
export const ABSENT_HEARTBEAT = Number.POSITIVE_INFINITY;

export function classifySessionHealth(
  containerStatus: string,
  heartbeatAgeMs: number,
  ceilingMs: number,
): SessionHealth {
  if (containerStatus === 'running') return heartbeatAgeMs >= ceilingMs ? 'stale' : 'running';
  return 'idle';
}

const HEALTH_ORDER: Record<AgentHealth, number> = { stale: 3, running: 2, idle: 1, never: 0 };

export function rollupHealth(sessionHealths: SessionHealth[]): AgentHealth {
  if (sessionHealths.length === 0) return 'never';
  return sessionHealths.reduce<AgentHealth>((worst, h) => (HEALTH_ORDER[h] > HEALTH_ORDER[worst] ? h : worst), 'idle');
}

export interface AgentStatus {
  folder: string;
  name: string;
  model: string | null;
  provider: string | null;
  health: AgentHealth;
  heartbeatAgeMs: number | null;
  lastActivityAt: string | null;
  activeSessions: number;
}

function readHeartbeatAgeMs(agentGroupId: string, sessionId: string, now: number): number {
  try {
    return now - fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return ABSENT_HEARTBEAT;
  }
}

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion != null) return cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export function handleGetStatus(session: PlaygroundSession): ApiResult<{
  host: { gatewayRunning: boolean; activeContainers: number; version: string };
  agents: AgentStatus[];
}> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner or admin required' } };
  }
  const now = Date.now();
  const agents: AgentStatus[] = getAllAgentGroups().map((g) => {
    const allSessions = getSessionsByAgentGroup(g.id);
    const sessions = allSessions.filter((s) => s.status === 'active'); // health + counts from live sessions only
    const sessionAges = sessions.map((s) => ({ s, age: readHeartbeatAgeMs(g.id, s.id, now) })); // stat once, reuse
    const healths = sessionAges.map(({ s, age }) =>
      classifySessionHealth(s.container_status, age, ABSOLUTE_CEILING_MS),
    );
    const runningAges = sessionAges
      .filter(({ s }) => s.container_status === 'running')
      .map(({ age }) => age)
      .filter((a) => Number.isFinite(a));
    const cfg = getContainerConfig(g.id);
    // ISO-8601 timestamps sort lexicographically === chronologically.
    const lastActivityAt =
      allSessions
        .map((s) => s.last_active)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    let health = rollupHealth(healths);
    if (health === 'never' && allSessions.length > 0) health = 'idle'; // has only closed sessions → idle, not 'never'
    return {
      folder: g.folder,
      name: g.name,
      model: cfg?.model ?? null,
      provider: cfg?.model_provider ?? null,
      health,
      heartbeatAgeMs: runningAges.length ? Math.min(...runningAges) : null,
      lastActivityAt,
      activeSessions: sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle').length,
    };
  });
  return {
    status: 200,
    body: {
      host: {
        gatewayRunning: getPlaygroundStatus().running,
        activeContainers: getActiveContainerCount(),
        version: appVersion(),
      },
      agents,
    },
  };
}

export function handlePostStatusRestart(
  session: PlaygroundSession,
  body: { folder?: unknown },
): ApiResult<{ ok: true; restarted: number }> {
  if (!isOwnerOrAdmin(session.userId)) return { status: 403, body: { error: 'owner or admin required' } };
  const folder = body.folder;
  if (typeof folder !== 'string' || !folder) return { status: 400, body: { error: 'folder required' } };
  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, body: { error: `Agent group not found: ${folder}` } };
  const restarted = restartAgentGroupContainers(group.id, 'owner-status-restart');
  return { status: 200, body: { ok: true, restarted } };
}
