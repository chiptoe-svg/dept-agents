/**
 * Owner-only admin: add a class student from the playground Home tab.
 *
 * `POST /api/admin/students` provisions one student (agent group, folder
 * scaffold, container.json, roster + membership rows) via
 * `provisionStudent()`, mints a class-login token, and returns a
 * ready-to-send login URL. When `external` is set it also starts a
 * 60-minute cloudflared tunnel and builds the URL on the tunnel host so
 * an off-campus guest can reach it.
 */
import { issueClassLoginToken } from '../../../class-login-tokens.js';
import { provisionStudent, type ProvisionStudentResult } from '../../../class-student-provision.js';
import { getGuestTunnel, startGuestTunnel, stopGuestTunnel, type GuestTunnelInfo } from '../../../class-tunnel.js';
import { lookupRosterByEmail } from '../../../db/classroom-roster.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import { isOwner } from '../../../modules/permissions/db/user-roles.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './me.js';

/** Campus-facing playground base URL (used for non-external adds). */
function campusBaseUrl(): string {
  const url = process.env.PUBLIC_PLAYGROUND_URL || readEnvFile(['PUBLIC_PLAYGROUND_URL']).PUBLIC_PLAYGROUND_URL;
  return (url || 'http://localhost:3002').replace(/\/+$/, '');
}

/** Drop ASCII control characters (a name/email is single-line plain text). */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

export interface AddStudentResponse {
  ok: true;
  folder: string;
  name: string;
  email: string;
  loginUrl: string;
  external: boolean;
  tunnel: GuestTunnelInfo | null;
  /** Set when `external` was requested but the tunnel failed to start. */
  tunnelError?: string;
}

export async function handleAddStudent(
  session: PlaygroundSession,
  body: { name?: unknown; email?: unknown; external?: unknown },
): Promise<ApiResult<AddStudentResponse>> {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }

  // Strip control chars and cap length: `name` flows into the agent
  // persona, `email` into the roster and the class-login token.
  const name = typeof body.name === 'string' ? stripControlChars(body.name).trim().slice(0, 100) : '';
  const email = typeof body.email === 'string' ? stripControlChars(body.email).trim().toLowerCase().slice(0, 200) : '';
  const external = body.external === true;

  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (!email || !email.includes('@')) return { status: 400, body: { error: 'a valid email is required' } };
  if (lookupRosterByEmail(email)) {
    return { status: 409, body: { error: `${email} is already on the roster` } };
  }

  let provisioned: ProvisionStudentResult;
  try {
    provisioned = provisionStudent({ name, email, addedBy: session.userId });
  } catch (err) {
    log.error('Add Student: provisioning failed', { err: String(err) });
    return { status: 500, body: { error: `Provisioning failed: ${(err as Error).message}` } };
  }

  const token = issueClassLoginToken(provisioned.userId);

  // External guest: serve the login URL on a fresh 60-min tunnel host.
  // If the tunnel fails to come up the student is still provisioned —
  // return the campus URL plus a tunnelError so the instructor can retry.
  let base = campusBaseUrl();
  let tunnel: GuestTunnelInfo | null = null;
  let tunnelError: string | undefined;
  if (external) {
    try {
      tunnel = await startGuestTunnel();
      base = tunnel.url;
    } catch (err) {
      tunnelError = (err as Error).message;
      log.error('Add Student: tunnel start failed', { err: tunnelError });
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      folder: provisioned.folder,
      name: provisioned.name,
      email: provisioned.email,
      loginUrl: `${base}/?token=${token}`,
      external,
      tunnel,
      tunnelError,
    },
  };
}

export function handleGetTunnel(session: PlaygroundSession): ApiResult<{ tunnel: GuestTunnelInfo | null }> {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  return { status: 200, body: { tunnel: getGuestTunnel() } };
}

export function handleStopTunnel(session: PlaygroundSession): ApiResult<{ stopped: boolean }> {
  if (!session.userId || !isOwner(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  return { status: 200, body: { stopped: stopGuestTunnel() } };
}
