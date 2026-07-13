/**
 * POST /api/me/privacy-mode — member-self Cloud↔Private toggle.
 *
 * Flips the CALLER's OWN agent group's active model between its cloud
 * choice (stashed in `agent_groups.metadata.cloudChoice`) and the
 * department's private (on-box) model.
 *
 * SECURITY: the agent group is resolved from the session — the same
 * `getPlaygroundAgentForUser(session.userId)` lookup GET /api/me/agent uses
 * for the plain-member case — never from the request body. `body.private`
 * is the only field this handler reads from the body; any other field
 * (e.g. a `folder`) is ignored, so a member cannot switch another member's
 * agent by passing a bogus target in the body.
 */
import {
  getAgentGroupMetadata,
  getPlaygroundAgentForUser,
  setAgentGroupMetadataKey,
} from '../../../db/agent-groups.js';
import { getDeptModelConfig } from '../../../db/app-config.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../../db/container-configs.js';
import { getActiveSessions } from '../../../db/sessions.js';
import { isContainerRunning, killContainer } from '../../../container-runner.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './me.js';

interface ModelSpec {
  provider: string;
  model: string;
}

function isModelSpec(v: unknown): v is ModelSpec {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { provider?: unknown }).provider === 'string' &&
    typeof (v as { model?: unknown }).model === 'string'
  );
}

/**
 * Best-effort: stop any running container for this agent group so the next
 * turn re-materializes container.json with the new model (the model is
 * baked in at container spawn). Never throws — the DB write already stands
 * regardless of whether the runtime recycle succeeds; the next turn picks
 * up the new model either via this recycle or the next natural respawn.
 */
function recycleContainerForGroup(agentGroupId: string): void {
  try {
    for (const s of getActiveSessions()) {
      if (s.agent_group_id !== agentGroupId) continue;
      if (!isContainerRunning(s.id)) continue;
      try {
        killContainer(s.id, 'privacy mode toggled');
      } catch {
        /* best-effort — a stale container is reaped by the next sweep */
      }
    }
  } catch {
    /* best-effort — DB write already stands */
  }
}

export function handlePrivacyMode(
  session: PlaygroundSession,
  body: { private?: unknown },
): ApiResult<{ private: boolean }> {
  const agentGroup = getPlaygroundAgentForUser(session.userId);
  if (!agentGroup) return { status: 401, body: { error: 'not signed in' } };
  const agentGroupId = agentGroup.id;

  let dept;
  try {
    dept = getDeptModelConfig();
  } catch {
    return { status: 409, body: { error: 'department model config not set' } };
  }

  const cc = getContainerConfig(agentGroupId);
  if (!cc) return { status: 409, body: { error: 'no container config' } };

  const goingPrivate = body?.private === true;

  if (goingPrivate) {
    // Stash the current cloud choice unless we're already on the private
    // pair (avoids clobbering a real stash with the private pair itself).
    if (!(cc.model_provider === dept.private.provider && cc.model === dept.private.model)) {
      setAgentGroupMetadataKey(agentGroupId, 'cloudChoice', {
        provider: cc.model_provider,
        model: cc.model,
      });
    }
    updateContainerConfigScalars(agentGroupId, {
      model_provider: dept.private.provider,
      model: dept.private.model,
    });
  } else {
    const stash = getAgentGroupMetadata(agentGroupId).cloudChoice;
    const restore = isModelSpec(stash)
      ? stash
      : { provider: dept.defaultCloud.provider, model: dept.defaultCloud.model };
    updateContainerConfigScalars(agentGroupId, {
      model_provider: restore.provider,
      model: restore.model,
    });
  }

  recycleContainerForGroup(agentGroupId);

  return { status: 200, body: { private: goingPrivate } };
}
