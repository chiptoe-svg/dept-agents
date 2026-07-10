/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  GWS_MCP_RELAY_PORT,
  TIMEZONE,
} from './config.js';
import { collectContainerEnv } from './container-env-registry.js';
import { materializeContainerJson, containerConfigPath } from './container-config.js';
import { collectMcpHeaderEnvRefs } from './mcp-header-env.js';
import { readEnvFile } from './env.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { mintContainerToken, revokeContainerToken } from './container-identity.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { detectAuthMode } from './credential-proxy.js';
import { readWebSearchProvider, readSearxngUrl, readBraveApiKey } from './web-search-config.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  // Ensure container.json has the agent group identity fields + the resolved
  // provider so the in-container runner picks the right runtime. Written at
  // spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup, provider);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  assertDirectoryMounts(mounts);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const { args, containerToken } = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    session.id,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  let container: ChildProcess;
  try {
    // Clear any orphan heartbeat from a previous container instance — the
    // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
    // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
    // immediate kill before the new container touches the file itself.
    fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

    container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // Spawn failed before we could attach exit handlers — the token
    // would otherwise leak until process restart. Revoke here since
    // the close/error handlers below never get a chance to fire.
    revokeContainerToken(containerToken);
    throw err;
  }

  // Attach close/error handlers immediately — before any bookkeeping that
  // could throw (markContainerRunning is a central-DB write) or that just
  // takes time (stdout/stderr wiring). If bookkeeping below throws,
  // spawnContainer rejects while the container keeps running; without the
  // handlers already attached, no close/error listener would ever fire and
  // revokeContainerToken would never run, leaving the per-container token
  // (a live credential) standing until host restart. Handler bodies below
  // reference `activeContainers` before the `.set()` call runs — that's
  // fine, `Map.delete` on a missing key is a no-op, and `revokeContainerToken`
  // (`Map.delete`) is idempotent, so a double-fire (error then close) is safe.
  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    revokeContainerToken(containerToken);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    revokeContainerToken(containerToken);
    log.error('Container spawn error', { sessionId: session.id, err });
  });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.
}

/**
 * Apple Container can only do directory bind mounts. Throws if any mount
 * source is an existing file — catches accidental reintroduction of nested
 * file mounts (the Docker-era pattern that silently broke spawn under Apple
 * Container with "path is not a directory"). Sources that don't exist yet
 * are not flagged: those are legitimate staging slots that the spawn flow
 * creates before the mount fires.
 */
export function assertDirectoryMounts(mounts: VolumeMount[]): void {
  for (const m of mounts) {
    if (!fs.existsSync(m.hostPath)) continue;
    if (fs.statSync(m.hostPath).isFile()) {
      throw new Error(
        `Mount source is a file, not a directory: ${m.hostPath} → ${m.containerPath}. ` +
          `Apple Container only supports directory bind mounts. ` +
          `Stage the file into a directory and mount the directory instead.`,
      );
    }
  }
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  // Optional onExit callback fires when the underlying process actually closes —
  // used by container-restart.ts to trigger an immediate respawn without waiting
  // for the next host-sweep tick.
  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → agent_groups.agent_provider
 *     → container.json `provider`
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  agentGroupProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || agentGroupProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, agentGroup.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

// Exported for direct testing (skills-confinement.test.ts) — confirms a
// group's mounts never resolve inside another group's folder.
export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig, path.resolve(GROUPS_DIR, agentGroup.folder));

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Apple Container only supports directory bind mounts, not file mounts.
  // The previously-nested RO file mounts (container.json, composed CLAUDE.md)
  // are accessible to the agent via the parent /workspace/agent dir mount
  // (it's RW for CLAUDE.local.md). The RO protection is lost: an agent could
  // overwrite its own container.json or composed CLAUDE.md, though the
  // composed CLAUDE.md is regenerated from the shared base + fragments on
  // every spawn so any agent writes are clobbered immediately. This is a
  // regression vs the Docker setup — tracked in memory.

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — stage into the session dir at spawn time so it can be
  // exposed via a directory mount (Apple Container can't do file mounts).
  // The session dir is already mounted RW at /workspace; the agent's
  // `.claude-shared.md` symlink target is /workspace/.shared/CLAUDE.md.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    const stagedSharedDir = path.join(sessDir, '.shared');
    fs.mkdirSync(stagedSharedDir, { recursive: true });
    fs.copyFileSync(sharedClaudeMd, path.join(stagedSharedDir, 'CLAUDE.md'));
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Per-provider fragment directory — read-only. destinations.ts looks up
  // /app/CLAUDE.providers/<provider>.md at runtime and appends it to the
  // system prompt when present. Skip the mount if the dir doesn't exist
  // on the host (vanilla install with no provider fragments).
  const providersSrc = path.join(projectRoot, 'container', 'CLAUDE.providers');
  if (fs.existsSync(providersSrc)) {
    mounts.push({ hostPath: providersSrc, containerPath: '/app/CLAUDE.providers', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  // Mount web hosting directory so agents can create and deploy websites.
  // Host path lives under /opt/homebrew/var/www/sites — user-writable
  // (no sudo needed), served by the user-level Homebrew Caddy on :8080.
  // Container path stays /var/www/sites so the make-website skill keeps
  // one canonical in-container path regardless of host OS conventions.
  const sitesDir = '/opt/homebrew/var/www/sites';
  if (fs.existsSync(sitesDir)) {
    mounts.push({
      hostPath: sitesDir,
      containerPath: '/var/www/sites',
      readonly: false,
    });
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  groupDir: string,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Container-side symlink target for one skill: a per-agent custom copy
  // (under the group folder, mounted at /workspace/agent) when one exists,
  // else the shared read-only /app/skills mount.
  const targetFor = (skill: string): string =>
    fs.existsSync(path.join(groupDir, 'custom-skills', skill))
      ? `/workspace/agent/custom-skills/${skill}`
      : `/app/skills/${skill}`;

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not desired; drop ones whose target is stale (a skill
  // can flip between the shared mount and a per-agent custom copy between
  // spawns) so the create pass below re-links them correctly.
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isSymlink) continue;
    if (!desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
      continue;
    }
    let current = '';
    try {
      current = fs.readlinkSync(entryPath);
    } catch {
      /* unreadable — treat as stale */
    }
    if (current !== targetFor(entry)) fs.unlinkSync(entryPath);
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(targetFor(skill), linkPath);
    }
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
  resolvedProvider: string,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.assistantName !== agentGroup.name) {
    containerConfig.assistantName = agentGroup.name;
    dirty = true;
  }
  if (containerConfig.provider !== resolvedProvider) {
    containerConfig.provider = resolvedProvider;
    dirty = true;
  }
  // Sync the per-group model override from container_configs. Undefined clears
  // any stale value so the in-container provider falls back to env / default.
  const ccRow = getContainerConfig(agentGroup.id);
  const desiredModel = ccRow?.model ?? undefined;
  if (containerConfig.model !== desiredModel) {
    containerConfig.model = desiredModel;
    dirty = true;
  }
  if (dirty) {
    const p = containerConfigPath(agentGroup.folder);
    fs.writeFileSync(p, JSON.stringify(containerConfig, null, 2) + '\n');
  }
}

export async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  // Required (not optional) because it's threaded straight into
  // mintContainerToken below — the only caller (spawnContainer) always
  // has a session id available.
  sessionId?: string,
): Promise<{ args: string[]; containerToken: string }> {
  if (!sessionId) {
    throw new Error('buildContainerArgs: sessionId is required to mint a container token');
  }
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Credential proxy: route API traffic through the local proxy so containers
  // never see real secrets. Mirror the host's auth method with a placeholder.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  // Native credential proxy: route container API calls to host:3001 with
  // placeholder credentials. Proxy substitutes real keys/OAuth tokens.
  const hostGateway = CONTAINER_HOST_GATEWAY();
  args.push('-e', `ANTHROPIC_BASE_URL=http://${hostGateway}:${CREDENTIAL_PROXY_PORT}/anthropic`);
  // OpenAI traffic routes through one of two proxy prefixes per the group's
  // active provider: `codex` (cloud OpenAI) → /openai/v1, `local`
  // (mlx-omni-server) → /omlx/v1. The proxy strips the prefix and substitutes
  // the appropriate API key per upstream.
  const openaiPrefix = provider === 'local' ? '/omlx/v1' : '/openai/v1';
  args.push('-e', `OPENAI_BASE_URL=http://${hostGateway}:${CREDENTIAL_PROXY_PORT}${openaiPrefix}`);

  // Google Workspace MCP relay — host-side gateway that the container's
  // gws.ts shims forward to. Per-call attribution header set by gws.ts.
  args.push('-e', `GWS_MCP_RELAY_URL=http://${hostGateway}:${GWS_MCP_RELAY_PORT}`);

  // Per-container capability token — the caller's real identity as far
  // as the credential proxy and GWS relay are concerned. Minted here at
  // spawn time and revoked by the container-exit handlers in
  // spawnContainer (close/error/spawn-failure). Not yet required by
  // either service (Tasks 5/6); adding it now is backward-compatible.
  const containerToken = mintContainerToken(agentGroup.id, sessionId);
  args.push('-e', `X_NANOCLAW_AGENT_TOKEN=${containerToken}`);

  // Per-call attribution for the credential proxy. The container's
  // proxy-fetch wrapper injects this as `X-NanoClaw-Agent-Group` on
  // every outbound request to the proxy. Keystone primitive used by
  // per-student credential resolvers (per-student GWS today; per-
  // student Anthropic / OpenAI auth in Phase 4). Missing-header
  // requests gracefully fall back to instructor / class-default
  // credentials at the proxy. Advisory only as of Task 5/6 — the token
  // above is the actual capability.
  args.push('-e', `X_NANOCLAW_AGENT_GROUP=${agentGroup.id}`);

  // Per-call session attribution for the credential proxy's payload log.
  // The container's proxy-fetch wrapper injects this as
  // `X-NanoClaw-Session-Id` on every outbound request to the proxy.
  // Missing-header requests fall back to the agent-group's
  // `unattributed.db` store; harmless.
  if (sessionId) {
    args.push('-e', `X_NANOCLAW_SESSION_ID=${sessionId}`);
  }

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // OpenAI SDKs refuse to initialize without OPENAI_API_KEY set, even when
  // OPENAI_BASE_URL overrides the endpoint. Placeholder satisfies the
  // SDK's env check; the proxy substitutes the real key in the
  // Authorization header before forwarding.
  args.push('-e', 'OPENAI_API_KEY=placeholder');
  // OMLX_API_KEY — needed when provider=local so codex's config.toml
  // env_key resolves; harmless on codex/claude containers since they
  // don't read it. Proxy substitutes the real bearer on /omlx requests.
  args.push('-e', 'OMLX_API_KEY=placeholder');
  // WEB_SEARCH_API_KEY — Brave Search token for pi's web_search tool. This
  // install has no OneCLI gateway to inject it at the proxy layer, so the tool
  // reads it from the container env. Forwarded from the host .env when set;
  // omitted otherwise (web_search then errors clearly rather than sending an
  // empty token). Lower-sensitivity than LLM keys, so direct env passthrough
  // is acceptable here (cf. the OneCLI install, which injects it via the vault).
  const braveApiKey = readBraveApiKey();
  if (braveApiKey) {
    args.push('-e', `WEB_SEARCH_API_KEY=${braveApiKey}`);
  }
  // Web-search backend selection (owner picks it install-wide in
  // data/config/web-search.json; the pi web_search tool dispatches on it).
  // Forward the provider + the SearXNG URL (Brave key already forwarded above).
  args.push('-e', `WEB_SEARCH_PROVIDER=${readWebSearchProvider()}`);
  const searxngUrl = readSearxngUrl();
  if (searxngUrl) {
    args.push('-e', `SEARXNG_URL=${searxngUrl}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Per-group env vars from container.json. Last writer wins, so these can
  // override provider defaults if a group genuinely needs to.
  if (containerConfig.env) {
    for (const [key, value] of Object.entries(containerConfig.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Extension-contributed env vars (e.g. class feature's GIT_AUTHOR_*
  // injection). Each contributor decides what to emit per agent group;
  // returns empty when nothing applies. No-op when no contributors are
  // registered (default install).
  for (const [key, value] of collectContainerEnv({ agentGroup })) {
    args.push('-e', `${key}=${value}`);
  }

  // Forward only the env vars referenced as ${VAR} in an MCP server's HTTP
  // headers — never the whole .env. See src/mcp-header-env.ts for the
  // security tradeoff this implies: unlike LLM API keys (which never enter
  // a container; the credential proxy substitutes them on the wire), these
  // tokens DO enter the container env so the in-container pi bridge's
  // resolveHeaders can expand them at connect time. That means any agent
  // wired to a credentialed MCP server can read that token out of its own
  // environment and use it directly, bypassing the MCP server. Scoping the
  // forward to exactly the referenced names (instead of the whole .env)
  // limits — but does not eliminate — that exposure.
  const headerEnvRefs = collectMcpHeaderEnvRefs(containerConfig.mcpServers);
  if (headerEnvRefs.length > 0) {
    const headerEnvValues = readEnvFile(headerEnvRefs);
    for (const key of headerEnvRefs) {
      if (headerEnvValues[key]) {
        args.push('-e', `${key}=${headerEnvValues[key]}`);
        continue;
      }
      // Never log the value — only the var name and which server(s)
      // reference it. A silently-unexpanded ${VAR} becomes a literal
      // bearer string and the server 401s with no clue why, so this has
      // to be loud.
      const referencingServers = Object.entries(containerConfig.mcpServers)
        .filter(([, cfg]) => cfg.headers && Object.values(cfg.headers).some((v) => v.includes(`\${${key}}`)))
        .map(([name]) => name);
      log.warn(`MCP header env var missing from .env — referencing server(s) will 401`, {
        envVar: key,
        servers: referencingServers,
      });
    }
  }

  // Apple Container VMs cannot resolve host.docker.internal (Docker-specific).
  // Replace it with the bridge gateway IP in any injected -e value, so a
  // Docker-era literal (e.g. copy-pasted into a per-group container.json env
  // override) resolves correctly inside the VM instead of failing DNS.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-e' && args[i + 1].includes('host.docker.internal')) {
      args[i + 1] = args[i + 1].replaceAll('host.docker.internal', hostGateway);
    }
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return { args, containerToken };
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroupId);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages
      .map((p: string) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`)
      .join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroupId, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
