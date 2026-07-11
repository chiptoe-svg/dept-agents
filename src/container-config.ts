/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 *   - `emptyConfig()` — classroom defaults (skills = [] not 'all')
 *   - `containerConfigPath()` — back-compat helper for tooling that inspects the file
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_SITES_ROOT, GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * MCP server transport config. Every server the operator actually runs is
 * HTTP (`url` + `headers`) — stdio (`command`) is the legacy/local-tool
 * shape. Exactly one of `command` or `url` must be set; `configFromDb`
 * throws at config-read time (naming the offending server) if neither is
 * present, rather than silently skipping a broken entry.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP MCP server endpoint. Mutually exclusive with `command`. */
  url?: string;
  /**
   * HTTP headers sent on connect. Values may reference `${VAR}` — see
   * `mcp-header-env.ts` for how those refs are collected and forwarded, and
   * the security tradeoff of doing so (unlike LLM keys, these tokens do
   * enter the container env).
   */
  headers?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (legacy). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Model override. Falls back to provider default if unset. */
  model?: string;
  /** Reasoning effort knob ('low'|'medium'|'high'|'xhigh'|'max'). */
  effort?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /**
   * Container-side root this group's published sites live under
   * (CONTAINER_SITES_ROOT/<folder>). The make-website skill writes here.
   * Keyed by the DB-unique `folder` — never the display name, which can
   * collide — so it always matches the per-group host mount in
   * buildMounts() (src/container-runner.ts).
   */
  sitesPath?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /**
   * Per-group environment variables passed to the container at spawn time
   * (classroom-only). Use sparingly — most config belongs in container.json
   * itself, read by the runner. This is for env vars consumed by code we
   * don't own (e.g. `GOOGLE_APPLICATION_CREDENTIALS` for the Google Workspace CLI).
   */
  env?: Record<string, string>;
  /**
   * Per-group allowlist of models the agent is permitted to route to
   * (classroom-only). When undefined, all catalog models are usable. Set via
   * the playground Models tab or `ncl groups config update`.
   */
  allowedModels?: { provider: string; model: string }[];
  /**
   * Pi-provider model provider (e.g. "anthropic", "openai"). Passed through
   * to the pi runner's modelProvider option. When unset, pi falls back to
   * the NANOCLAW_PI_MODEL_PROVIDER env var, then its own default.
   */
  modelProvider?: string;
}

/** Classroom default: skills explicitly granted (empty, not "all"). */
export function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
  };
}

/** Path the container.json gets materialized to. For tooling that inspects the file. */
export function containerConfigPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * Validate that every MCP server has a usable transport, and rewrite
 * `host.docker.internal` in HTTP server URLs to the real bridge gateway.
 *
 * `host.docker.internal` is Docker-specific and doesn't resolve inside
 * Apple Container VMs — operators habitually write it anyway (copy-pasted
 * from Docker-era configs), so this substitutes the live gateway
 * (`CONTAINER_HOST_GATEWAY()`) rather than leaving a dead hostname that
 * fails DNS with no clue why.
 *
 * A server with neither `command` nor `url` can never be reached — throw
 * naming the server rather than silently dropping it, so a bad config
 * fails loudly at materialize time instead of showing up as a missing
 * tool the agent can't explain.
 */
function rewriteAndValidateMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const gateway = CONTAINER_HOST_GATEWAY();
  const result: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.command && !cfg.url) {
      throw new Error(`MCP server "${name}" has neither "command" nor "url" — invalid config, cannot connect.`);
    }
    result[name] = {
      ...cfg,
      url: cfg.url?.replace('host.docker.internal', gateway),
    };
  }
  return result;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  const rawMcpServers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  return {
    mcpServers: rewriteAndValidateMcpServers(rawMcpServers),
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    sitesPath: `${CONTAINER_SITES_ROOT}/${group.folder}`,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    env: row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined,
    allowedModels: row.allowed_models
      ? (JSON.parse(row.allowed_models) as { provider: string; model: string }[])
      : undefined,
    modelProvider: row.model_provider ?? undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = containerConfigPath(group.folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
