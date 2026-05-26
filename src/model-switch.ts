/**
 * Per-agent-group model selection.
 *
 * `container_configs.model` is the source of truth. At spawn time, the host
 * materializes container.json from the DB so the in-container provider reads
 * the resolved model from the RO mount.
 *
 * Suggested-model hints (`/model` listing) and alias expansion live in
 * `./model-discovery.js`, which fetches the live list from the provider
 * with a 1-hour cache and a hardcoded fallback.
 */
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { getActiveSessions } from './db/sessions.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { materializeContainerJson } from './container-config.js';
import { getModelCatalog } from './model-catalog.js';

export { expandAlias, hintsForProvider } from './model-discovery.js';
export type { ModelHint } from './model-discovery.js';

export function getCurrentModel(folder: string): { provider: string | null; model: string | null } | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return null;
  const cfg = getContainerConfig(group.id);
  return { provider: group.agent_provider, model: cfg?.model ?? null };
}

/**
 * Resolve the effective model the next container spawn will use, mirroring
 * the precedence in the in-container provider:
 *   container_configs.model → env (CODEX_MODEL/ANTHROPIC_MODEL) → catalog default for
 *   provider → provider name as last-resort placeholder
 *
 * Pre-fix this returned '(unknown)' for any provider other than codex/claude,
 * which silently propagated into container.json on provider-switch and broke
 * the in-container provider's model selection. Now consults the model catalog
 * as a generic fallback so adding a provider via the registry doesn't require
 * touching this file.
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
  // Generic fallback for any other registered provider: first catalog entry
  // for that provider. Used by local/opencode/pi/etc. without per-provider
  // branches here.
  const fromCatalog = getModelCatalog().find((entry) => entry.provider === provider);
  if (fromCatalog) return fromCatalog.id;
  // Last resort: surface the provider name so the operator sees something
  // meaningful in `ncl groups get` output rather than the cryptic '(unknown)'.
  return `${provider}-default`;
}

export function setModel(folder: string, model: string | null): boolean {
  const group = getAgentGroupByFolder(folder);
  if (!group) return false;
  updateContainerConfigScalars(group.id, { model });
  materializeContainerJson(group.id);

  // Stop any running session containers so the model change is visible on the
  // next inbound message. The in-container provider reads model from the
  // container.json snapshot at spawn time; a live container keeps using the
  // old model until it exits. Mirrors the kill pattern in setProvider.
  // Best-effort: errors are non-fatal — the next host sweep tick reaps stale
  // containers anyway.
  for (const session of getActiveSessions().filter((s) => s.agent_group_id === group.id)) {
    try {
      if (isContainerRunning(session.id)) killContainer(session.id, 'model change');
    } catch {
      /* best-effort */
    }
  }
  return true;
}
