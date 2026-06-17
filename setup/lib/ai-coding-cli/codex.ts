/**
 * OpenAI Codex adapter for the setup-helper registry.
 *
 * Headless: `codex exec "<prompt>"` — non-interactive subcommand,
 * prints the agent's reply to stdout.
 * Handoff:  `codex "<prompt>"` — bare `codex [PROMPT]` opens the
 * interactive TUI with the prompt as the opening message.
 *
 * Auth probe: codex doesn't expose a non-network `auth status` we can
 * probe in <1s. Treat as `undefined` — setup will proceed and let
 * actual usage surface the error if auth is broken.
 *
 * Install: codex has no scriptable installer in this fork yet (the
 * upstream `/add-codex` skill installs it via pnpm global). Returning
 * `null` for installScript means setup tells the user to install
 * manually rather than trying to auto-install.
 */
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HeadlessOpts, SpawnArgs, AiCodingCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  // codex has no fast offline auth-probe; we let actual invocation surface
  // the error rather than block setup on a network round-trip.
  return undefined;
}

function headless(prompt: string, _opts: HeadlessOpts = {}): SpawnArgs {
  // `codex exec` already permits tool use in its sandbox; opts.tools is
  // accepted for API uniformity but doesn't change the argv.
  return {
    args: ['exec', prompt],
    stdin: 'ignore',
    output: 'pipe',
  };
}

function handoff(prompt: string): SpawnArgs {
  return {
    args: [prompt],
    stdin: 'inherit',
    output: 'inherit',
  };
}

/**
 * Generate a single "router" skill at ~/.codex/skills/nanoclaw-features/.
 *
 * Why one router instead of symlinking all ~54 skills: Codex's skill
 * discovery is machine-global and injects the name+description of every
 * skill it finds into the developer message of *every* Codex session,
 * whether or not you're touching nanoclaw. Symlinking all 54 added ~20KB
 * of dead context to every request on the machine. Instead we expose ONE
 * skill whose own listing is a single line; its tightly-scoped description
 * only matches "add/install a nanoclaw channel or integration", so it
 * doesn't fire during unrelated work. Codex reads this skill's BODY only
 * on demand once the router fires — i.e. only when you're actually adding
 * a feature.
 *
 * The body does NOT embed a snapshot index of the skills (that would go
 * stale, since this is regenerated only at install / --reconfigure-cli,
 * not on every Codex launch). Instead it tells Codex to enumerate the live
 * .claude/skills/ directory at invocation time, so newly pulled or edited
 * skills are always picked up. Only the absolute skills path is baked in —
 * stable unless the install moves, which re-runs setup anyway. Idempotent.
 */
function writeNanoclawSkillRouter(projectRoot: string): void {
  const skillsDir = path.join(projectRoot, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return;

  const body = `---
name: nanoclaw-features
description: Add, install, or configure a feature in this NanoClaw agent install — a chat channel (Telegram, Slack, Discord, WhatsApp, iMessage, Signal, Matrix, etc.), an agent provider (Codex, OpenCode, Ollama), a classroom, or any other nanoclaw integration. Use ONLY when the user wants to add/wire/install such a capability.
---

# NanoClaw feature installers

NanoClaw ships its install/configure workflows as skills under
\`${skillsDir}/<name>/SKILL.md\`. They are the equivalent of Claude Code's
\`/add-telegram\`-style slash commands.

## How to use

1. Enumerate what's available *right now* (don't rely on a cached list —
   skills get added/edited between setup runs):

   \`\`\`bash
   grep -L '^description: DEPRECATED' ${skillsDir}/*/SKILL.md \\
     | xargs grep -h -m1 '^\\(name\\|description\\):' 2>/dev/null
   \`\`\`

   For skills without YAML frontmatter, fall back to their first \`#\` heading:
   \`head -n1 ${skillsDir}/<name>/SKILL.md\`.

2. Pick the skill whose description matches the user's request, read its full
   \`${skillsDir}/<name>/SKILL.md\`, and follow it exactly. Skip any whose
   description starts with \`DEPRECATED\`.

3. These SKILL.md files were written for Claude Code. Apply the Codex
   tool-equivalents from \`${path.join(projectRoot, 'AGENTS.md')}\` (use
   \`apply_patch\` for edits, \`rg\` for search, shell \`cat\`/\`sed\` for reads).
`;

  const dest = path.join(os.homedir(), '.codex', 'skills', 'nanoclaw-features');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), body);
}

/**
 * Prepare the Codex environment for working on this nanoclaw repo:
 *   1. Generate the on-demand `nanoclaw-features` router skill.
 *   2. Add the codegraph MCP server to ~/.codex/config.toml (only if the
 *      codegraph binary is on PATH and the section isn't already present).
 *
 * Both operations are idempotent.
 */
function prepareEnvironment(projectRoot: string): void {
  writeNanoclawSkillRouter(projectRoot);

  const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
  let hasCodegraph = false;
  if (fs.existsSync(codexConfigPath)) {
    hasCodegraph = fs.readFileSync(codexConfigPath, 'utf-8').includes('[mcp_servers.codegraph]');
  }
  if (!hasCodegraph) {
    const probe = spawnSync('which', ['codegraph'], { stdio: 'ignore' });
    if (probe.status === 0) {
      const block = '\n[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n';
      fs.appendFileSync(codexConfigPath, block);
    }
    // codegraph not installed — skip; user can add it later
  }
}

export const codexCli: AiCodingCli = {
  name: 'codex',
  displayName: 'OpenAI Codex',
  binary: 'codex',
  isInstalled,
  isAuthenticated,
  installScript: null,
  headless,
  handoff,
  prepareEnvironment,
};
