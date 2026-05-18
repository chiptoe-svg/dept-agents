/**
 * Per-agent-group model selection.
 *
 * `agent_groups.model` is the source of truth. At spawn time, the host
 * passes the resolved model into container.json so the in-container
 * provider reads it from the RO mount.
 *
 * Suggested-model hints (`/model` listing) and alias expansion live in
 * `./model-discovery.js`, which fetches the live list from the provider
 * with a 1-hour cache and a hardcoded fallback.
 */
import { getAgentGroupByFolder, updateAgentGroup } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';

export { expandAlias, hintsForProvider } from './model-discovery.js';
export type { ModelHint } from './model-discovery.js';

export function getCurrentModel(folder: string): { provider: string | null; model: string | null } | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return null;
  return { provider: group.agent_provider, model: group.model };
}

/**
 * Resolve the effective model the next container spawn will use, mirroring
 * the precedence in the in-container provider:
 *   group.model → env (CODEX_MODEL/ANTHROPIC_MODEL) → provider's hardcoded default
 */
export function resolveEffectiveModel(group: { agent_provider: string | null; model: string | null }): string {
  if (group.model) return group.model;
  const provider = (group.agent_provider || 'claude').toLowerCase();
  if (provider === 'codex') {
    return process.env.CODEX_MODEL || 'gpt-5.5';
  }
  if (provider === 'claude') {
    return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  }
  return '(unknown)';
}

export function setModel(folder: string, model: string | null): boolean {
  const group = getAgentGroupByFolder(folder);
  if (!group) return false;
  updateAgentGroup(group.id, { model });

  // Stop any running session containers so the model change is visible on the
  // next inbound message. The in-container provider reads model from the
  // container.json snapshot at spawn time; a live container keeps using the
  // old model until it exits. Mirrors the kill pattern in setProvider.
  // Best-effort: errors are non-fatal — the next host sweep tick reaps stale
  // containers anyway.
  for (const session of getActiveSessions().filter((s) => s.agent_group_id === group.id)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { isContainerRunning, killContainer } = require('./container-runner.js') as {
        isContainerRunning: (id: string) => boolean;
        killContainer: (id: string, reason: string) => void;
      };
      if (isContainerRunning(session.id)) killContainer(session.id, 'model change');
    } catch {
      /* best-effort */
    }
  }
  return true;
}
