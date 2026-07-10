/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Runtime: Apple Container (macOS-only). For Docker, see git history.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { INSTALL_SLUG } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

/**
 * The container runtime binary name.
 * Reads NANOCLAW_CONTAINER_RUNTIME from env; defaults to 'container' (Apple Container).
 * Set to 'docker' for Linux installs or macOS installs that prefer Docker.
 */
const CONFIGURED_CONTAINER_RUNTIME =
  process.env.NANOCLAW_CONTAINER_RUNTIME ?? readEnvFile(['NANOCLAW_CONTAINER_RUNTIME']).NANOCLAW_CONTAINER_RUNTIME;

export const CONTAINER_RUNTIME_BIN: string = resolveContainerRuntimeBin(CONFIGURED_CONTAINER_RUNTIME);

function resolveContainerRuntimeBin(runtime: string | undefined): string {
  if (!runtime || runtime === 'apple-container' || runtime === 'container') {
    for (const candidate of ['/opt/homebrew/bin/container', '/usr/local/bin/container']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'container';
  }
  return runtime;
}

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
  if (CONTAINER_RUNTIME_BIN === 'docker') {
    ensureDockerRunning();
  } else {
    ensureAppleContainerRunning();
  }
}

function ensureAppleContainerRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    log.debug('Container runtime already running');
  } catch {
    log.info('Starting container runtime');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
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
      throw new Error('Container runtime is required but failed to start', { cause: err });
    }
  }
}

function ensureDockerRunning(): void {
  const probe = spawnSync('docker', ['info'], { stdio: 'pipe' });
  if (probe.status === 0) {
    log.debug('Docker already running');
    return;
  }
  // Try to start. On macOS open Docker Desktop; on Linux use systemctl.
  if (os.platform() === 'darwin') {
    spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  } else {
    spawnSync('sudo', ['systemctl', 'start', 'docker'], { stdio: 'pipe' });
  }
  // Poll up to 30s (15 × 2s)
  for (let i = 0; i < 15; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    if (spawnSync('docker', ['info'], { stdio: 'pipe' }).status === 0) {
      log.info('Docker started');
      return;
    }
  }
  log.error('Docker did not become ready within 30s');
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Docker failed to start                                 ║');
  console.error('║                                                                ║');
  console.error('║  Agents cannot run without a container runtime. To fix:        ║');
  console.error('║  1. Ensure Docker is installed and start Docker Desktop        ║');
  console.error('║  2. Restart NanoClaw                                           ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
  throw new Error('Container runtime is required but failed to start');
}

/**
 * Normalizes `container ls --format json`'s `status` field, which changed
 * shape between runtime versions: a bare string ("running") through
 * container 0.12.x, an object ({ state: "running" }) from 1.0.0 onward
 * (PR #1656 — containers conform to ManagedResource).
 *
 * Never throws. Any shape it cannot interpret (undefined, null, an object
 * with a missing/non-string `state`) returns '' rather than 'running' —
 * fail closed for the orphan-reaping caller, which only acts on a confirmed
 * 'running' match. Returning '' means an unrecognized shape is never mistaken
 * for a live container and never gets stopped.
 */
export function containerState(status: unknown): string {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && 'state' in status) {
    const s = (status as { state: unknown }).state;
    if (typeof s === 'string') return s;
    // object with non-string state value — unrecognizable
    log.warn('Unrecognized container status shape — orphan reaping may be skipping containers', { status });
    return '';
  }
  if (status !== null && status !== undefined) {
    // object with no state key — unrecognizable
    log.warn('Unrecognized container status shape — orphan reaping may be skipping containers', { status });
  }
  return '';
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
      status: unknown;
      configuration: {
        id: string;
        labels?: Record<string, string>;
      };
    };
    const containers: ContainerListEntry[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) => containerState(c.status) === 'running' && c.configuration.labels?.['nanoclaw-install'] === INSTALL_SLUG,
      )
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
