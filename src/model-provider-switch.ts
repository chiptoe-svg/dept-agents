/**
 * Atomically set the model-provider and model for an agent group, then kill
 * any running containers so the next inbound message picks up the change.
 *
 * Mirrors the container-kill side-effect in setProvider (provider-switch.ts)
 * and setModel (model-switch.ts). Those legacy files are deleted in d-3;
 * this is the single implementation going forward.
 */
import { updateContainerConfigScalars } from './db/container-configs.js';
import { materializeContainerJson } from './container-config.js';
import { getActiveSessions } from './db/sessions.js';
import { isContainerRunning, killContainer } from './container-runner.js';

export async function setModelProviderAndModel(
  agentGroupId: string,
  opts: { modelProvider: string; model: string },
): Promise<void> {
  const { modelProvider, model } = opts;

  // 1. Persist to the DB.
  updateContainerConfigScalars(agentGroupId, { model_provider: modelProvider, model });

  // 2. Sync container.json so the next spawn sees the new values immediately.
  materializeContainerJson(agentGroupId);

  // 3. Kill running containers — best-effort. Errors here are non-fatal:
  //    the host sweep will reap stale containers on its next tick, and the
  //    DB write above is already the source of truth.
  for (const session of getActiveSessions().filter((s) => s.agent_group_id === agentGroupId)) {
    try {
      if (isContainerRunning(session.id)) {
        killContainer(session.id, `model-provider change to ${modelProvider}/${model}`);
      }
    } catch {
      /* best-effort */
    }
  }
}
