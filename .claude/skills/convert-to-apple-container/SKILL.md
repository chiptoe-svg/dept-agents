---
name: convert-to-apple-container
description: Switch from Docker to Apple Container for macOS-native container isolation. Use when the user wants Apple Container instead of Docker, or is setting up on macOS and prefers the native runtime. Triggers on "apple container", "convert to apple container", "switch to apple container", or "use apple container".
---

# Convert to Apple Container

Switches NanoClaw's container runtime from Docker to Apple Container (macOS-only). Apple Container runs each container in a Linux VM and uses VirtioFS for bind mounts.

**Key constraint:** Apple Container's kernel does NOT support file-level bind mounts (verified empirically — `mount --bind` over a file fails with "not a directory"). Only directory mounts work. The pre-Apple-Container Docker setup had three nested RO file mounts (`container.json`, composed `CLAUDE.md`, shared `/app/CLAUDE.md`); these have to be restructured.

**What this changes:**
- `src/container-runtime.ts` — Docker → Apple Container CLI (`container ls --format json`, `container system status/start`, `--mount type=bind,...,readonly`)
- `src/container-runner.ts` — drop two nested RO file mounts; stage shared CLAUDE.md to a session-dir directory; add `assertDirectoryMounts` guard
- `src/claude-md-compose.ts` — update SHARED_CLAUDE_MD_CONTAINER_PATH to the staged location
- `src/container-runtime.test.ts` — replaced with Apple Container behavioral tests + guard tests
- `src/index.ts` — validate `CREDENTIAL_PROXY_HOST` is set at startup
- `container/build.sh` — default runtime: `docker` → `container`
- `.env` — add `CREDENTIAL_PROXY_HOST=0.0.0.0` (Apple Container has no loopback default — bridge100 only exists while a container runs, but the proxy must start before any container)
- launchd plist — prepend `/opt/homebrew/bin` to PATH so the host service can find `container`

**What this does NOT change:**
- `Dockerfile` (no changes needed — Apple Container builds standard OCI images, `USER node` is honored)
- Setup scripts (`setup/*`) — they still hardcode `docker`. Re-running `/setup` will fail. Tracked in memory as a follow-up.
- Container-side code (`container/agent-runner/`) — agent reads its shared CLAUDE.md via the updated path constant

**Security regression accepted:** `groups/<folder>/container.json` was RO via nested file mount under Docker; under Apple Container it becomes writable via the parent dir mount. Apple Container's kernel makes the equivalent protection (file bind mounts) impossible. The threat model already gives the agent enough capability (API token, code execution, persistent memory writes) that this incremental escalation isn't worth the engineering cost of restructuring container.json out of the writable mount. See the project memory note `setup-scripts-docker-residue.md`.

## Prerequisites

Verify macOS + Apple Container support:

```bash
[ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || echo "Apple Container requires macOS on Apple Silicon"
```

If not Apple Silicon macOS, stop here — this skill only applies to that platform.

## Phase 1: Install Apple Container

```bash
container --version 2>/dev/null || brew install container
```

After install, start the runtime (it needs a one-time kernel install on first run):

```bash
yes | container system start 2>&1 | tail -3
container system status | head -3
```

## Phase 2: Detect prior application

Check whether this skill has already been applied:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo APPLIED || echo PENDING
```

If `APPLIED`, skip to Phase 6 (verify). Otherwise continue.

## Phase 3: Working tree hygiene

This skill rewrites several files. Make sure the working tree is clean (or that any pending changes are intentional and won't conflict).

```bash
git status --short
```

If unrelated uncommitted changes exist, commit or stash them first. The skill operates on:
- `src/container-runtime.ts` (full rewrite)
- `src/container-runtime.test.ts` (full rewrite)
- `src/container-runner.ts` (targeted edits)
- `src/claude-md-compose.ts` (one-line edit)
- `src/index.ts` (small edit)
- `container/build.sh` (one-line edit)

## Phase 4: Apply code changes

Write `src/container-runtime.ts` (full replacement):

```typescript
/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Runtime: Apple Container (macOS-only). For Docker, see git history.
 */
import { execSync } from 'child_process';
import os from 'os';

import { INSTALL_SLUG } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 * Detected from bridge100/bridge0, falling back to 192.168.64.1.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Must be set via CREDENTIAL_PROXY_HOST in .env — there is no safe default
 * for Apple Container because bridge100 only exists while containers run,
 * but the proxy must start before any container.
 * The /convert-to-apple-container skill sets this during setup.
 *
 * Validated at startup in src/index.ts before the proxy starts.
 */
export const PROXY_BIND_HOST: string =
  process.env.CREDENTIAL_PROXY_HOST ?? readEnvFile(['CREDENTIAL_PROXY_HOST']).CREDENTIAL_PROXY_HOST ?? '';

/** CLI args needed for the container to resolve the host gateway. Apple Container needs none. */
export function hostGatewayArgs(): string[] {
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Stop a container by name. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    log.debug('Container runtime already running');
  } catch {
    log.info('Starting container runtime');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      log.info('Container runtime started');
    } catch (err) {
      log.error('Failed to start container runtime', { err });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Apple Container is installed                        ║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', {
        cause: err,
      });
    }
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    type ContainerListEntry = {
      status: string;
      configuration: {
        id: string;
        labels?: Record<string, string>;
      };
    };
    const containers: ContainerListEntry[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.labels?.['nanoclaw-install'] === INSTALL_SLUG)
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
```

Write `src/container-runtime.test.ts` (full replacement):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  hostGatewayArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { INSTALL_SLUG } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CONTAINER_RUNTIME_BIN', () => {
  it('targets the Apple Container CLI', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('container');
  });
});

describe('readonlyMountArgs', () => {
  it('returns --mount with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--mount', 'type=bind,source=/host/path,target=/container/path,readonly']);
  });
});

describe('hostGatewayArgs', () => {
  it('returns no extra args (Apple Container resolves the host via the bridge gateway)', () => {
    expect(hostGatewayArgs()).toEqual([]);
  });
});

describe('stopContainer', () => {
  it('calls container stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`, { stdio: 'pipe' });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');
    ensureContainerRuntimeRunning();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('starts the runtime when system status fails', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('not running'); });
    mockExecSync.mockReturnValueOnce('');
    ensureContainerRuntimeRunning();
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} system start`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    expect(log.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('Apple Container unavailable'); });
    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('cleanupOrphans', () => {
  function fakeContainer(id: string, status: string, installSlug?: string) {
    return {
      status,
      configuration: { id, labels: installSlug ? { 'nanoclaw-install': installSlug } : {} },
    };
  }

  it('asks container ls for JSON output', () => {
    mockExecSync.mockReturnValueOnce('[]');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} ls --format json`, expect.any(Object));
  });

  it('stops running containers labeled with this install slug', () => {
    mockExecSync.mockReturnValueOnce(JSON.stringify([
      fakeContainer('nanoclaw-group1-111', 'running', INSTALL_SLUG),
      fakeContainer('nanoclaw-group2-222', 'running', INSTALL_SLUG),
    ]));
    mockExecSync.mockReturnValue('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('skips peer installs (different label) and stopped containers', () => {
    mockExecSync.mockReturnValueOnce(JSON.stringify([
      fakeContainer('nanoclaw-mine', 'running', INSTALL_SLUG),
      fakeContainer('nanoclaw-peer', 'running', 'some-other-install'),
      fakeContainer('nanoclaw-stopped', 'stopped', INSTALL_SLUG),
    ]));
    mockExecSync.mockReturnValue('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error('container not available'); });
    cleanupOrphans();
    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce(JSON.stringify([
      fakeContainer('nanoclaw-a-1', 'running', INSTALL_SLUG),
      fakeContainer('nanoclaw-b-2', 'running', INSTALL_SLUG),
    ]));
    mockExecSync.mockImplementationOnce(() => { throw new Error('already stopped'); });
    mockExecSync.mockReturnValueOnce('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });
});
```

Edit `src/index.ts` — add `CREDENTIAL_PROXY_HOST` startup validation around the proxy start. Find the block that starts the proxy:

```typescript
  // 2b. Credential proxy — containers route API calls through this so they
  // never see real secrets. Binds to loopback only; containers reach it via
  // the host-gateway address injected by buildContainerArgs.
  proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
```

Replace with:

```typescript
  // 2b. Credential proxy — containers route API calls through this so they
  // never see real secrets. Apple Container has no host-loopback default
  // (bridge100 only exists while a container is running), so PROXY_BIND_HOST
  // must be explicitly set in .env via /convert-to-apple-container.
  if (!PROXY_BIND_HOST) {
    throw new Error(
      'CREDENTIAL_PROXY_HOST is not set in .env. Run /convert-to-apple-container to configure.',
    );
  }
  proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
```

Edit `container/build.sh`. Find:

```bash
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
```

Replace with:

```bash
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
```

Edit `src/claude-md-compose.ts`. Find:

```typescript
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
```

Replace with:

```typescript
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/workspace/.shared/CLAUDE.md';
```

Edit `src/container-runner.ts`. Find the three nested file mounts in `buildMounts`:

```typescript
  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }
```

Replace with:

```typescript
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
```

Then add the runtime guard. Find this in `spawnContainer`:

```typescript
  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
```

Replace with:

```typescript
  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);
  assertDirectoryMounts(mounts);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
```

Add the `assertDirectoryMounts` function. Find the `killContainer` declaration:

```typescript
/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
```

Insert above it:

```typescript
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
export function killContainer(sessionId: string, reason: string): void {
```

Add a guard test in `src/container-runner.test.ts`. Replace the existing imports:

```typescript
import { describe, expect, it } from 'vitest';

import { resolveProviderName } from './container-runner.js';
```

with:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDirectoryMounts, resolveProviderName } from './container-runner.js';
```

Append at the bottom of the file:

```typescript
describe('assertDirectoryMounts', () => {
  let tmp: string;
  let dir: string;
  let file: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
    dir = path.join(tmp, 'a-dir');
    file = path.join(tmp, 'a-file');
    fs.mkdirSync(dir);
    fs.writeFileSync(file, 'x');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts directory sources', () => {
    expect(() => assertDirectoryMounts([{ hostPath: dir, containerPath: '/x', readonly: false }])).not.toThrow();
  });

  it('throws when any source is a file (the regression we keep catching)', () => {
    expect(() =>
      assertDirectoryMounts([
        { hostPath: dir, containerPath: '/x', readonly: false },
        { hostPath: file, containerPath: '/y', readonly: true },
      ]),
    ).toThrow(/Mount source is a file/);
  });

  it('ignores non-existent paths (legitimate staging slots created at spawn)', () => {
    const ghost = path.join(tmp, 'does-not-exist');
    expect(() => assertDirectoryMounts([{ hostPath: ghost, containerPath: '/x', readonly: false }])).not.toThrow();
  });
});
```

## Phase 5: Validate code changes

```bash
pnpm test
pnpm run build
```

Both must succeed before proceeding.

## Phase 6: Configure CREDENTIAL_PROXY_HOST

Apple Container needs the credential proxy bound to `0.0.0.0` (the bridge interface only exists while a container is running, but the proxy must start before any container). On a private/home network this is fine. On a shared/public network add a firewall rule blocking inbound on port 3001.

Ask the user:

> The credential proxy needs to bind to all interfaces (0.0.0.0). Is this Mac on a trusted private network, or shared/public?

For private: just add the env var.

```bash
grep -q '^CREDENTIAL_PROXY_HOST=' .env 2>/dev/null || echo 'CREDENTIAL_PROXY_HOST=0.0.0.0' >> .env
```

For public, also add a persistent pf firewall rule:

```bash
grep -q 'CREDENTIAL_PROXY_HOST' .env 2>/dev/null || echo 'CREDENTIAL_PROXY_HOST=0.0.0.0' >> .env
grep -q 'nanoclaw proxy' /etc/pf.conf 2>/dev/null || echo '# nanoclaw proxy — block LAN access to credential proxy
block in on en0 proto tcp to any port 3001' | sudo tee -a /etc/pf.conf > /dev/null
sudo pfctl -ef /etc/pf.conf 2>&1 | head -3
curl -sf "http://$(ipconfig getifaddr en0):3001" && echo "EXPOSED — rule not working" || echo "BLOCKED — rule active"
```

## Phase 7: Fix launchd PATH

The host service runs under launchd, which doesn't inherit your shell PATH. `container` lives in `/opt/homebrew/bin`, which launchd doesn't include by default.

Find the plist:

```bash
ls ~/Library/LaunchAgents/com.nanoclaw*.plist
```

The filename is `com.nanoclaw-v2-<install-slug>.plist` (the slug comes from `setup/lib/install-slug.sh`). Edit the `PATH` env variable inside it to prepend `/opt/homebrew/bin`:

```bash
PLIST=$(ls ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist | head -1)
# Backup
cp "$PLIST" "$PLIST.bak"
# Prepend /opt/homebrew/bin to PATH (idempotent — check first)
grep -q '/opt/homebrew/bin' "$PLIST" || sed -i.tmp 's|<string>/usr/local/bin|<string>/opt/homebrew/bin:/usr/local/bin|' "$PLIST" && rm -f "$PLIST.tmp"
grep '<string>/opt/homebrew/bin' "$PLIST"
```

## Phase 8: Build the container image

```bash
container system status 2>&1 | head -1
./container/build.sh
container image ls | grep nanoclaw-agent
```

## Phase 9: Smoke tests

Basic exec:

```bash
IMAGE=$(container image ls --format json 2>/dev/null | grep -o 'nanoclaw-agent[^"]*' | head -1)
container run --rm --entrypoint /bin/echo "$IMAGE" "container OK"
```

Readonly directory mount:

```bash
mkdir -p /tmp/nc-test-ro && echo "data" > /tmp/nc-test-ro/file.txt
container run --rm --entrypoint /bin/bash --mount type=bind,source=/tmp/nc-test-ro,target=/test,readonly "$IMAGE" \
  -c "cat /test/file.txt && (touch /test/new 2>&1 || echo 'write blocked OK')"
rm -rf /tmp/nc-test-ro
```

Read-write directory mount:

```bash
mkdir -p /tmp/nc-test-rw
container run --rm --entrypoint /bin/bash -v /tmp/nc-test-rw:/test "$IMAGE" \
  -c "echo 'data' > /test/new && cat /test/new"
rm -rf /tmp/nc-test-rw
```

## Phase 10: Restart the service + end-to-end test

```bash
PLIST=$(ls ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist | head -1)
LABEL=$(basename "$PLIST" .plist)
launchctl unload "$PLIST" 2>&1
launchctl load "$PLIST"
sleep 3
launchctl list | grep "$LABEL"
```

Status should be `0` (running). If `1` or higher, check `logs/nanoclaw.error.log`.

End-to-end: send a message and confirm a reply.

```bash
pnpm run chat "ping — confirm you're on Apple Container"
```

Should respond within ~30 seconds. The agent's reply should mention it's on `aarch64 Linux` (Apple Container runs Linux VMs on Apple Silicon).

## Troubleshooting

**`container: command not found` after kickstart.** Launchd PATH isn't picking up `/opt/homebrew/bin`. Re-check the plist edit in Phase 7 and reload.

**`CREDENTIAL_PROXY_HOST is not set in .env`.** Re-check Phase 6 — confirm the entry is in `.env` and the host has been rebuilt (`pnpm run build`).

**Container exits with code 1, ~40ms after spawn.** Almost certainly a file mount sneaking in. Enable stderr logging temporarily (change `log.debug` to `log.info` in `container.stderr.on('data', ...)` in `spawnContainer`), restart, retry, look for "path is not a directory". The `assertDirectoryMounts` guard should catch this at spawn time with a clearer error — make sure it's wired in (Phase 4).

**Build runs forever or fails.** Apple Container caches builds aggressively. Clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

**Image build hits a kernel install prompt.** First `container system start` after install needs a kernel — pipe `yes`:

```bash
yes | container system start
```

## Compatibility

**Vanilla NanoClaw v2:** the skill should apply cleanly on current trunk. All edited files live in trunk's runtime path. The skill includes phase 2 (already-applied detection) so re-running is idempotent.

**Heavily customized installs:** the skill operates on trunk runtime files only (`container-runtime.ts`, `container-runner.ts`, `claude-md-compose.ts`, `index.ts`, `container/build.sh`). It does NOT touch:
- Channel adapters (`src/channels/*`)
- Setup scripts (`setup/*`)
- Provider implementations (`src/providers/*` except where they happen to share runtime hooks)
- Per-group filesystem (`groups/*`)
- Any `add-*` skill code

Risk areas in a customized install:
- If a fork has its own modifications to `container-runner.ts` `spawnContainer` or `buildMounts`, the edits in Phase 4 may not find their target strings. Resolve manually — the patterns are small and unambiguous.
- If a fork's `container/CLAUDE.md` is unusually large (multiple MB), the per-spawn copy adds proportional latency. Practical limit on the existing copy is small; not a concern for any reasonable CLAUDE.md.
- If a fork ships a contributor that adds a FILE mount via `additionalMounts` or a registered provider mount, the new `assertDirectoryMounts` guard will throw at spawn time with a clear error pointing at the offending mount. Fix the contributor to mount the parent directory instead.

**Container-side code (`container/agent-runner/`):** unchanged. The agent-runner reads its shared CLAUDE.md via the path in `claude-md-compose.ts`, which the skill updates. No agent-runner edits are needed.

**Setup-time docker references (`setup/*`):** out of scope. Re-running `/setup` after this conversion will fail at any of the several `docker info` / `docker build` probes. That's a separate piece of work — tracked in the project memory note `setup-scripts-docker-residue.md`.
