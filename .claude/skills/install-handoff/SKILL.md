---
name: install-handoff
description: Generate time-limited single-use HTTP URLs that bundle everything needed to clone this NanoClaw install onto a new machine. Replaces the hand-rolled _migrate-<token>/ + python -m http.server pattern. Triggers on "install handoff", "clone install", "migrate to new machine", "setup handoff URL".
---

# Install Handoff

Adds `ncl handoffs create|list|revoke` and a short-lived HTTP server that serves a self-contained install bundle. One command on the source machine generates a magic link; the operator opens it on the target machine and the bundle downloads. The link expires after a configurable TTL (default 24 h) and is consumed after a configurable number of downloads (default 1). The host-sweep loop auto-cleans expired tokens and purges `data/handoffs/` bundles.

The **token is the auth** — the URL contains a cryptographically random 32-byte token. There is no separate login page. Share the URL only with yourself or a trusted operator.

## Prerequisites

- NanoClaw host service must be running (the handoff HTTP server piggybacks on the same process).
- `INSTALL_HANDOFF_PORT` (default 3008) must be reachable from wherever you want to use the URL. If the source machine is behind NAT, set `INSTALL_HANDOFF_PUBLIC_URL` to your Tailscale, LAN, or ngrok address before running `ncl handoffs create`.
- No new npm dependencies — the handoff server uses Node's built-in `http` module and `better-sqlite3` which is already installed.

## Install

### Pre-flight (idempotent — skip if all true)

- `src/install-handoff/server.ts` exists
- `src/install-handoff/bundler.ts` exists
- `src/install-handoff/store.ts` exists
- `src/cli/resources/handoffs.ts` exists
- `src/db/migrations/module-install-handoffs.ts` exists
- `src/db/migrations/index.ts` contains the `install-handoff:migrations START` sentinel
- `src/cli/resources/index.ts` contains `import './handoffs.js';`
- `src/index.ts` contains the `install-handoff:lifecycle START` sentinel
- `src/host-sweep.ts` contains the `install-handoff:sweep START` sentinel

If all nine are true, skip to **Configure**.

### 1. Copy source files

`-n` skips existing files — re-running install won't clobber local edits.

```bash
mkdir -p src/install-handoff
cp -n .claude/skills/install-handoff/add/src/install-handoff/server.ts             src/install-handoff/
cp -n .claude/skills/install-handoff/add/src/install-handoff/bundler.ts            src/install-handoff/
cp -n .claude/skills/install-handoff/add/src/install-handoff/store.ts              src/install-handoff/
cp -n .claude/skills/install-handoff/add/src/install-handoff/install-template.html src/install-handoff/
```

### 2. Copy CLI resource

```bash
cp -n .claude/skills/install-handoff/add/src/cli/resources/handoffs.ts src/cli/resources/
```

### 3. Copy DB migration

```bash
cp -n .claude/skills/install-handoff/add/src/db/migrations/module-install-handoffs.ts src/db/migrations/
```

### 4. Register the DB migration (sentinel-bounded, idempotent)

Check first:

```bash
grep -q 'install-handoff:migrations START' src/db/migrations/index.ts
```

If not found, append to `src/db/migrations/index.ts` **before** the closing of the file, adding after the last existing import and inside the `migrations` array:

Import (add alongside existing imports):

```typescript
// install-handoff:migrations START
import { moduleInstallHandoffs } from './module-install-handoffs.js';
// install-handoff:migrations END
```

Array entry (add inside `const migrations: Migration[] = [...]`):

```typescript
// install-handoff:migrations START
  moduleInstallHandoffs,
// install-handoff:migrations END
```

The sentinel pair appears twice — once in the import block and once in the array. Both must be present and match the REMOVE.md removal pattern.

### 5. Register the CLI resource (idempotent)

```bash
grep -q "handoffs.js" src/cli/resources/index.ts \
  || echo "import './handoffs.js';" >> src/cli/resources/index.ts
```

### 6. Wire handoff-server start/stop into host lifecycle (sentinel-bounded, idempotent)

Check first:

```bash
grep -q 'install-handoff:lifecycle START' src/index.ts
```

If not found, locate the `// 7. Start the \`ncl\` CLI socket server` comment in `src/index.ts` and insert the following block **before** it (inside the `main()` function body):

```typescript
  // install-handoff:lifecycle START
  const { startHandoffServer, stopHandoffServer } = await import('./install-handoff/server.js');
  await startHandoffServer();
  onShutdown(async () => { await stopHandoffServer(); });
  // install-handoff:lifecycle END
```

And in the `shutdown()` function body, the `onShutdown` callback registered above handles teardown automatically — no separate addition needed there.

### 7. Wire handoff-sweep into host-sweep (sentinel-bounded, idempotent)

Check first:

```bash
grep -q 'install-handoff:sweep START' src/host-sweep.ts
```

If not found, locate the `sweep()` function in `src/host-sweep.ts` (around line 133, NOT `sweepSession`) and add the following block **after** the `await backupCentralDb();` line and **before** the `getActiveSessions()` call. Once-per-tick is the right cadence — the store function is fast and idempotent, but doesn't need per-session invocation:

```typescript
    // install-handoff:sweep START
    try {
      const { sweepExpiredHandoffs } = await import('./install-handoff/store.js');
      sweepExpiredHandoffs();
    } catch (err) {
      log.warn('install-handoff sweep failed', { err });
    }
    // install-handoff:sweep END
```

The dynamic import keeps trunk's `host-sweep.ts` free of a hard dependency on the install-handoff module — if the skill is uninstalled (REMOVE.md run), the sweep block goes away with it; if the skill files are present but the module fails to load for some reason, sweep continues running for sessions.

### 8. Verify lockfile

No new runtime dependencies. Sanity-check the lockfile is clean:

```bash
pnpm install --frozen-lockfile
```

### 9. Build

```bash
pnpm run build
```

The build must be clean before continuing. TypeScript errors here mean a step above was applied incorrectly or a sentinel block has a syntax issue.

### 10. Restart the host service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Configure

Add to `.env` (idempotent — each line only added once):

```bash
# Port the handoff HTTP server listens on. Must be reachable from the target
# machine. Change if 3008 conflicts with another service.
grep -q '^INSTALL_HANDOFF_PORT=' .env || echo 'INSTALL_HANDOFF_PORT=3008' >> .env

# Public URL included in the generated link. Set to your Tailscale address,
# LAN IP, or any URL that routes to this machine's INSTALL_HANDOFF_PORT.
# Defaults to http://localhost:3008 (only useful if source == target machine).
grep -q '^INSTALL_HANDOFF_PUBLIC_URL=' .env || echo 'INSTALL_HANDOFF_PUBLIC_URL=http://localhost:3008' >> .env
```

Restart the host after changing these values.

## Usage

### Create a handoff URL

```
ncl handoffs create [--ttl <duration>] [--max-uses <n>] [--include <items>] [--exclude <items>]
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--ttl` | `24h` | How long the URL is valid. Accepts `<n>h`, `<n>d`, `<n>m` (minutes). |
| `--max-uses` | `1` | How many times the bundle can be downloaded before the URL is revoked. |
| `--include` | (see Bundle contents) | Comma-separated extra items to include. |
| `--exclude` | (none) | Comma-separated items to exclude from the default bundle. |

Example:

```
ncl handoffs create --ttl 2h --max-uses 1 --include groups,claude-creds
```

Example output:

```
Handoff created.

  URL:       http://192.168.1.42:3008/handoff/v1Kx9mP2rQn8Tz3jWdLfYcE4bA6sNuHe
  Expires:   2026-05-15 14:30 UTC (2 hours)
  Max uses:  1
  Bundle:    .env, gws-creds, codex-creds, groups

Open the URL on the target machine to download the install bundle.
The URL is single-use — it becomes invalid after the first download.
```

### List active handoffs

```
ncl handoffs list
```

Output:

```
ID          EXPIRES              USES/MAX  URL
a1b2c3d4    2026-05-15 14:30     0/1       http://192.168.1.42:3008/handoff/v1Kx9...
```

### Revoke a handoff

```
ncl handoffs revoke <id>
```

Immediately invalidates the URL and deletes the bundle from disk.

## Bundle contents

### Default bundle

| Item | Source path(s) | Notes |
|------|---------------|-------|
| `.env` | `.env` | Always included (core secrets). |
| `gws-creds` | `data/gws-credentials.json`, `data/gws-tokens/` | Skipped silently if no GWS credentials are present. |
| `codex-creds` | `data/codex/auth.json` | Skipped silently if `/add-codex` is not installed. |

### Opt-in items (`--include`)

| Item | Source path(s) | Notes |
|------|---------------|-------|
| `groups` | `groups/` | Per-agent-group directories (CLAUDE.md, persona, skills). Potentially large. |
| `claude-creds` | `~/.claude/.credentials.json` | OAuth token. Include only if the target machine will use the same Anthropic account. |

### Opting out (`--exclude`)

Any default item can be excluded:

```
ncl handoffs create --exclude gws-creds,codex-creds
```

This creates a `.env`-only bundle — useful when the target machine already has its own GWS and Codex credentials.

## Security model

- **Token is the auth.** The 32-byte random token in the URL is the only credential. There is no separate login page or session cookie.
- **TTL limits exposure window.** A leaked URL stops working when the TTL expires. Default 24 h; reduce to 1 h or less for sensitive installs.
- **Use counter limits blast radius.** `--max-uses 1` (the default) means a forwarded URL can only be used once — whoever downloads first wins.
- **Auto-cleanup.** The host-sweep loop marks expired tokens invalid and deletes their bundle files from `data/handoffs/`. Bundles are never served once marked expired, even if sweep hasn't run yet (the server checks expiry + use count on every request).
- **No HTTPS by default.** The handoff server does not terminate TLS. For remote transfers, use a Tailscale or VPN link, or run behind a TLS-terminating reverse proxy. Plain HTTP over the open internet is not recommended for a bundle containing `.env`.
- **Bundle is transient.** The `.tar.gz` bundle is written to `data/handoffs/<token>/bundle.tar.gz` at create time and deleted when the token is revoked or expires.
