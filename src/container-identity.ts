/**
 * Per-container identity.
 *
 * Host services (credential proxy, GWS MCP relay) must know WHICH agent
 * group is calling. Before this module they trusted an `x-nanoclaw-agent-group`
 * request header that the container itself set — so any container could
 * claim to be any group and have another user's credentials attached to its
 * upstream calls.
 *
 * Instead: the host mints an unguessable token per container at spawn, passes
 * it in as an env var, and resolves token → group server-side. The token is
 * the capability; the group header is advisory (logging) at most.
 *
 * In-memory by design — a token's lifetime is its container's, and a host
 * restart reaps every container (see cleanupOrphans).
 */
import crypto from 'crypto';

export interface ContainerIdentity {
  agentGroupId: string;
  sessionId: string;
}

const tokens = new Map<string, ContainerIdentity>();

export function mintContainerToken(agentGroupId: string, sessionId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { agentGroupId, sessionId });
  return token;
}

export function resolveContainerToken(token: string | undefined | null): ContainerIdentity | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function revokeContainerToken(token: string): void {
  tokens.delete(token);
}

/** Test hook — drop every token. */
export function _resetForTest(): void {
  tokens.clear();
}
