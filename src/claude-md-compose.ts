/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * See `docs/claude-md-composition.md` for the full design.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { materializeContainerJson, type McpServerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/workspace/.shared/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

// Resolved-persona size guard. `groups/<folder>/CLAUDE.md` is only a
// manifest of @-imports, so its own byte count is meaningless — what
// actually reaches the system prompt is the SUM of everything Claude Code
// resolves (shared base + fragments + CLAUDE.local.md). Warn well above a
// healthy size; hard-fail only on the pathological, usually an unbounded
// CLAUDE.local.md. Ported from the personal repo's agents-compose.ts
// (same budget — this repo doesn't compose the extra per-harness /
// per-model-provider fragments Pi needs, so nothing here runs hotter).
export const PERSONA_WARN_BYTES = 48 * 1024;
export const PERSONA_HARD_MAX_BYTES = 64 * 1024;

function byteSizeOf(hostPath: string | null): number {
  if (!hostPath) return 0;
  try {
    return fs.statSync(hostPath).size;
  } catch {
    return 0;
  }
}

/**
 * Map a fragment's container path (the symlink target — `/app/skills/...`,
 * `/app/src/...`) back to its host source, so the resolved size can be
 * summed at compose time. Returns null for an unrecognized base (counted
 * as zero — better to under- than over-count).
 */
function hostPathForContainer(containerPath: string | null): string | null {
  if (!containerPath) return null;
  const root = process.cwd();
  const bases: Array<[string, string]> = [
    [SHARED_SKILLS_CONTAINER_BASE, path.join(root, 'container', 'skills')],
    ['/app/src', path.join(root, 'container', 'agent-runner', 'src')],
  ];
  for (const [cBase, hBase] of bases) {
    if (containerPath === cBase || containerPath.startsWith(`${cBase}/`)) {
      return hBase + containerPath.slice(cBase.length);
    }
  }
  return null;
}

/**
 * Fail-loud guard on the resolved persona size. Warn above {@link PERSONA_WARN_BYTES};
 * throw above {@link PERSONA_HARD_MAX_BYTES} so a runaway system prompt (usually an
 * unbounded per-group memory file) blocks the spawn loudly instead of silently
 * burning tokens every turn. Pure (apart from the warn log) — unit-tested directly.
 */
export function evaluatePersonaSize(resolvedBytes: number, ctx: { group: string; memoryFile: string }): void {
  if (resolvedBytes > PERSONA_HARD_MAX_BYTES) {
    throw new Error(
      `Composed persona for group "${ctx.group}" resolves to ${(resolvedBytes / 1024).toFixed(1)} KB, over the ` +
        `${PERSONA_HARD_MAX_BYTES / 1024} KB hard cap. Refusing to spawn with a runaway system prompt — the usual ` +
        `cause is an unbounded ${ctx.memoryFile} (per-group memory) or a large MCP \`instructions\` blob. Trim it and respawn.`,
    );
  }
  if (resolvedBytes > PERSONA_WARN_BYTES) {
    log.warn('Composed persona is large', {
      group: ctx.group,
      resolvedKb: +(resolvedBytes / 1024).toFixed(1),
      warnKb: PERSONA_WARN_BYTES / 1024,
      hardKb: PERSONA_HARD_MAX_BYTES / 1024,
    });
  }
}

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 */
export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const config = materializeContainerJson(group.id);
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — every skill that ships an `instructions.md`.
  // TODO (shared-source refactor): respect `container.json` skill selection.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir)) {
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        desired.set(`skill-${skillName}.md`, {
          type: 'symlink',
          content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
        });
      }
    }
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Always included — these are built-in, not toggleable.
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(config.mcpServers) as [string, McpServerConfig][]) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }

  // CLAUDE.local.md is not @-imported above — Claude Code auto-loads it
  // from the working directory on its own — but its bytes still land in
  // the system prompt, so it counts toward the size budget below. Ensure
  // it exists before sizing it.
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }

  // Fail-loud guard on the *resolved* persona size — the sum of everything
  // that actually reaches the system prompt, not the composed manifest's
  // own (tiny) byte count. See evaluatePersonaSize.
  let resolvedBytes = byteSizeOf(path.join(process.cwd(), 'container', 'CLAUDE.md'));
  for (const frag of desired.values()) {
    resolvedBytes +=
      frag.type === 'inline'
        ? Buffer.byteLength(frag.content, 'utf-8')
        : byteSizeOf(hostPathForContainer(frag.content));
  }
  resolvedBytes += byteSizeOf(localFile);
  evaluatePersonaSize(resolvedBytes, { group: group.folder, memoryFile: 'CLAUDE.local.md' });

  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
