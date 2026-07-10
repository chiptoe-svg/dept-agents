/**
 * Task 6 backfill — seed the operator's curated default MCP server set
 * (config/default-mcp-servers.json) onto every existing agent group whose
 * container_configs.mcp_servers is currently empty (`{}`).
 *
 * Never overwrites a non-empty mcp_servers value — groups that already have
 * servers wired (e.g. via the add_mcp_server approval flow) are left alone.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-default-mcp-servers.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { materializeContainerJson } from '../src/container-config.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { readDefaultMcpServers } from '../src/group-init.js';

initDb(path.join(DATA_DIR, 'v2.db'));

const defaults = readDefaultMcpServers();
if (Object.keys(defaults).length === 0) {
  console.log('config/default-mcp-servers.json is absent or empty — nothing to backfill.');
  process.exit(0);
}

const groups = getAllAgentGroups();
let backfilled = 0;

for (const group of groups) {
  const row = getContainerConfig(group.id);
  if (!row) {
    console.log(`  - ${group.id} (${group.folder}): no container_configs row, skipping`);
    continue;
  }

  const current = JSON.parse(row.mcp_servers) as Record<string, unknown>;
  if (Object.keys(current).length > 0) {
    console.log(`  - ${group.id} (${group.folder}): mcp_servers already non-empty, skipping`);
    continue;
  }

  updateContainerConfigJson(group.id, 'mcp_servers', defaults);
  materializeContainerJson(group.id);
  backfilled++;
  console.log(`  ✓ ${group.id} (${group.folder}): seeded ${Object.keys(defaults).length} default servers`);
}

console.log(`\nBackfilled ${backfilled} of ${groups.length} agent group(s).`);
