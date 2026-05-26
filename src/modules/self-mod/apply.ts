/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config in the DB, rebuilds/kills the container as needed,
 * and writes an on_wake message so the fresh container picks up where
 * the old one left off.
 *
 * install_packages: update DB + rebuild image + kill container + on_wake.
 * add_mcp_server: update DB + kill container + on_wake.
 */
import { materializeContainerJson } from '../../container-config.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { buildAgentGroupImage } from '../../container-runner.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { log } from '../../log.js';
import type { McpServerConfig } from '../../container-config.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroupId = session.agent_group_id;

  const row = getContainerConfig(agentGroupId);
  if (!row) {
    notify('install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(row.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroupId, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(row.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroupId, 'packages_npm', existing);
  }

  materializeContainerJson(agentGroupId);

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId, userId });
  try {
    await buildAgentGroupImage(agentGroupId);
    restartAgentGroupContainers(
      agentGroupId,
      'install_packages applied',
      `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
    );
    log.info('Container rebuild completed (bundled with install)', { agentGroupId });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId, err: e });
  }
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroupId = session.agent_group_id;

  const row = getContainerConfig(agentGroupId);
  if (!row) {
    notify('add_mcp_server approved but container config missing.');
    return;
  }

  // Add the new MCP server to the existing map in the DB
  const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  servers[payload.name as string] = {
    command: payload.command as string,
    args: (payload.args as string[]) || [],
    env: (payload.env as Record<string, string>) || {},
  };
  updateContainerConfigJson(agentGroupId, 'mcp_servers', servers);

  materializeContainerJson(agentGroupId);

  restartAgentGroupContainers(
    agentGroupId,
    'mcp server added',
    `MCP server "${payload.name as string}" added. Verify it's available (e.g. list your tools) and report the result to the user.`,
  );
  log.info('MCP server add approved', { agentGroupId, userId });
};
