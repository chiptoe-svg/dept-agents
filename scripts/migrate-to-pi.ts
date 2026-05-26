/**
 * Phase D step 1 — migrate the kept agent groups onto provider=pi with the
 * proven anthropic+claude-sonnet-4-5 combo. Aligns all three drift sources:
 *   - agent_groups.agent_provider
 *   - container_configs.provider
 *   - container_configs.model
 *   - container_configs.env.NANOCLAW_PI_MODEL_PROVIDER (until model_provider
 *     column lands in step 3 of Phase D)
 * Also overwrites sessions.agent_provider for any existing session, otherwise
 * the host's resolver picks 'codex' from the stale session row and mounts
 * the wrong auth dir (see project-phase-c-awaits-live-test memory note).
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-to-pi.ts <agent-group-id> [<id>...]
 */
import { initDb, getDb } from '../src/db/connection.js';
import {
  updateAgentGroup,
  getAgentGroup,
} from '../src/db/agent-groups.js';
import {
  updateContainerConfigScalars,
  updateContainerConfigJson,
  getContainerConfig,
} from '../src/db/container-configs.js';
import { materializeContainerJson } from '../src/container-config.js';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('Usage: pnpm exec tsx scripts/migrate-to-pi.ts <agent-group-id> [...]');
  process.exit(1);
}

initDb('/Users/admin/projects/nanoclaw/data/v2.db');
const db = getDb();

for (const id of ids) {
  const group = getAgentGroup(id);
  if (!group) {
    console.error(`  ✗ ${id}: not found`);
    continue;
  }
  const before = getContainerConfig(id);
  const beforeProvider = before?.provider ?? '(none)';
  const beforeModel = before?.model ?? '(none)';

  // 1. agent_groups.agent_provider (legacy column read by resolveProviderName)
  updateAgentGroup(id, { agent_provider: 'pi' });

  // 2. container_configs.provider + model
  updateContainerConfigScalars(id, { provider: 'pi', model: 'claude-sonnet-4-5' });

  // 3. container_configs.env — preserve any existing env, add the modelProvider escape hatch
  const existingEnv = before?.env ? (JSON.parse(before.env) as Record<string, string>) : {};
  updateContainerConfigJson(id, 'env', { ...existingEnv, NANOCLAW_PI_MODEL_PROVIDER: 'anthropic' });

  // 4. sessions.agent_provider — match so the host resolver doesn't fall back to the stale value
  db.prepare("UPDATE sessions SET agent_provider='pi' WHERE agent_group_id=?").run(id);

  // 5. Materialize container.json so the next spawn sees the new config
  materializeContainerJson(id);

  console.log(
    `  ✓ ${id} (${group.name}/${group.folder}): ${beforeProvider}/${beforeModel} → pi/claude-sonnet-4-5 (modelProvider=anthropic)`,
  );
}
