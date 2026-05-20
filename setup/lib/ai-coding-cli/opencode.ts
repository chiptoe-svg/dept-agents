/**
 * OpenCode adapter for the setup-helper registry.
 *
 * Headless: `opencode run "<prompt>"` — non-interactive subcommand,
 * prints the agent's reply to stdout in human-readable format.
 * `--format json` is available if a future caller needs structured
 * output, but the current cli-assist + tz-from-cli consumers parse
 * plain text, so we stay on the default format for parity with
 * `claude -p --output-format text` and `codex exec`.
 *
 * Handoff:  `opencode "<prompt>"` — bare invocation opens the
 * interactive TUI with the prompt as the opening message.
 *
 * Tools-on (assist flow): `--dangerously-skip-permissions` is
 * OpenCode's analog to Claude's `--permission-mode bypassPermissions`.
 * Codex's `exec` doesn't need an equivalent because it sandboxes
 * tool use by default.
 *
 * Auth probe: OpenCode has `auth list` / `auth login` / `auth logout`
 * but no exit-code-bearing status check. Treat as `undefined` —
 * setup will proceed and let actual usage surface the error if auth
 * is broken (same posture as the codex adapter).
 *
 * Install: OpenCode is installed in this fork via the `/add-opencode`
 * skill (which also handles the agent-provider integration).
 * `installScript` is `null` — setup tells the user to run
 * `/add-opencode` manually rather than auto-installing.
 */
import { execSync } from 'child_process';

import type { HeadlessOpts, SpawnArgs, AiCodingCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v opencode', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  // opencode's auth surface (auth list / login / logout) doesn't expose
  // a fast offline status check we can probe in <1s. Let actual
  // invocation surface the error rather than block setup on a probe.
  return undefined;
}

function headless(prompt: string, opts: HeadlessOpts = {}): SpawnArgs {
  const args = ['run'];
  if (opts.tools) {
    // bypassPermissions equivalent — lets the assist flow Read files
    // and run Bash diagnostics without per-tool prompts in print mode.
    args.push('--dangerously-skip-permissions');
  }
  args.push(prompt);
  return {
    args,
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

export const opencodeCli: AiCodingCli = {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  isInstalled,
  isAuthenticated,
  installScript: null,
  headless,
  handoff,
};
