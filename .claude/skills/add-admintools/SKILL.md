---
name: add-admintools
description: Install one or more host-side Telegram admin tools (/auth, /model, /provider) into the running NanoClaw instance. Trunk ships without them so the base codebase stays lean; operators opt in via this skill. Triggers on "add admin tools", "install admin commands", "add /model", "add /auth", "add /provider".
---

# Add Admin Tools

Installs interactive Telegram slash commands that let an operator manage the NanoClaw instance from a chat. None of these are required for normal operation — agents work fine without them — they're operator quality-of-life.

| Tool | Command | What it does |
|---|---|---|
| auth | `/auth` | Show / switch credential mode (API key vs OAuth) |
| model | `/model` | Show / switch the per-group model with live discovery + short typeable aliases (`opus`, `sonnet`, `5.5`, `5.4mini`) |
| provider | `/provider` | Show / switch the per-group agent provider (claude, codex, ...) |

## Prerequisites

- Telegram channel installed (`/add-telegram` already run; `src/channels/telegram.ts` exists). The tools register Telegram commands and will not load without it.
- Operator role on the host (these are admin commands; trunk's command-gate.ts already restricts them to owner/admin).

## Step 1: Pick which tools to install

Ask the user via AskUserQuestion (`multiSelect: true`):

- **All — install /auth, /model, /provider** (description: "Convenience: installs every admin tool. Recommended for instructor / single-operator installs.")
- **/auth — switch API-key vs OAuth** (description: "Show or switch the credential mode the proxy uses. Useful when toggling between `claude login` (OAuth) and `ANTHROPIC_API_KEY` (API key) without restarting the host.")
- **/model — show/switch model with aliases** (description: "Live model list from the configured provider, capped at 4 entries with short typeable aliases. Custom endpoints honored via `<PROVIDER>_BASE_URL`.")
- **/provider — show/switch agent provider** (description: "Switch a group between claude, codex, etc. Updates container.json, sessions.agent_provider, and stops the running container atomically.")

Treat the selection as a set: if "All" is among the choices, install all three. Otherwise install only the chosen ones. If the user selects nothing, stop here.

## Step 2: Fetch the admin source branch

```bash
git fetch origin admin
```

If `origin/admin` doesn't exist, this skill is being run on a fork that hasn't published the admin tools yet. Tell the user: "This fork's `origin` doesn't have an `admin` branch. Either point `origin` at a fork that publishes one (`https://github.com/chiptoe-svg/nanoclaw_gccourse.git`), or skip and the install can't complete."

## Step 3: Copy files for each chosen tool

Run **only** the blocks for tools the user selected. Each block is idempotent — re-running overwrites with the upstream version.

### /auth

```bash
git show origin/admin:src/admin-handlers/auth.ts > src/admin-handlers/auth.ts
git show origin/admin:src/auth-switch.ts        > src/auth-switch.ts
```

### /model

Only the Telegram-command handler. The supporting helpers
(`model-switch.ts`, `model-discovery.ts`, `model-providers/*`) ship
in trunk because trunk's playground Models tab API imports them
directly.

```bash
git show origin/admin:src/admin-handlers/model.ts > src/admin-handlers/model.ts
```

### /provider

Only the Telegram-command handler and its interactive switch
script. `provider-switch.ts` (and its test) live in trunk.

```bash
git show origin/admin:src/admin-handlers/provider.ts > src/admin-handlers/provider.ts
git show origin/admin:scripts/switch-provider.ts     > scripts/switch-provider.ts
```

## Step 4: Update the admin-handlers barrel

Read `src/admin-handlers/index.ts`. Append exactly one `import` line per installed tool, alphabetical, only if the line isn't already present (idempotent). Final state for "all":

```ts
/**
 * Admin-handler barrel.
 * ... (existing comment block)
 */
import './auth.js';
import './model.js';
import './provider.js';
```

Order doesn't matter functionally; alphabetical keeps diffs small if more tools are added later.

## Step 5: Build and verify

```bash
pnpm run build
pnpm test
```

If the build fails on a missing import (e.g. `'../auth-switch.js'` not found), the corresponding helper file wasn't copied. Re-check Step 3 for that tool.

## Step 6: Restart the service

```bash
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

The new commands are registered at startup. Test by sending the bot the bare command (`/auth`, `/model`, or `/provider`) — Felix should respond with the status reply.

## Removal

To uninstall, delete the same files copied in Step 3 and remove the corresponding `import` lines from `src/admin-handlers/index.ts`. Build + restart. The tools cleanly de-register because nothing else in trunk references them.
