import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock env.js so gateway-precedence tests never touch the real .env file.
vi.mock('./env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./env.js')>();
  return { ...actual, readEnvFile: vi.fn(() => ({})) };
});

import os from 'os';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  hostGatewayArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  containerState,
} from './container-runtime.js';
import { INSTALL_SLUG } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// Spy on the real os.networkInterfaces (rather than vi.mock('os', ...)) so
// interface-scan tests are deterministic regardless of what's actually
// running on the machine executing the suite. `os` is a genuine Node
// builtin singleton shared by this file and container-runtime.ts's own
// `import os from 'os'` — including across the resetModules()-triggered
// dynamic re-imports in the CONTAINER_HOST_GATEWAY() describe block below,
// since resetModules() only clears Vite's SSR module registry, not Node's
// native module cache that backs core modules. vi.mock('os', ...) was
// tried first and did NOT reliably intercept those re-imports; spyOn
// mutates the shared object directly and does.
const networkInterfacesSpy = vi.spyOn(os, 'networkInterfaces');

/** Builds a minimal-but-fully-typed fake NetworkInterfaceInfo for gateway tests. */
function fakeIface(family: 'IPv4' | 'IPv6', address: string): import('os').NetworkInterfaceInfo {
  const base = { address, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal: false };
  return family === 'IPv4'
    ? { ...base, family: 'IPv4', cidr: `${address}/24` }
    : { ...base, family: 'IPv6', cidr: `${address}/64`, scopeid: 0 };
}

// --- Pure functions ---

describe('CONTAINER_RUNTIME_BIN', () => {
  it('targets the Apple Container executable', () => {
    expect(CONTAINER_RUNTIME_BIN === 'container' || CONTAINER_RUNTIME_BIN.endsWith('/container')).toBe(true);
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
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('starts the runtime when system status fails', () => {
    // First call (status) throws, second call (start) succeeds
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
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
    mockExecSync.mockImplementation(() => {
      throw new Error('Apple Container unavailable');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- containerState ---

describe('containerState', () => {
  it('passes through a bare string (container 0.12.x)', () => {
    expect(containerState('running')).toBe('running');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads .state from an object (container 1.x)', () => {
    expect(containerState({ state: 'running' })).toBe('running');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not throw on undefined and fails closed (not "running")', () => {
    expect(containerState(undefined)).not.toBe('running');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not throw on null and fails closed (not "running")', () => {
    expect(containerState(null)).not.toBe('running');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns on a non-string state and fails closed (not "running")', () => {
    const result = containerState({ state: 123 });
    expect(result).not.toBe('running');
    expect(result).toBe('');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Unrecognized container status shape — orphan reaping may be skipping containers',
      { status: { state: 123 } },
    );
  });

  it('warns on an object with no state key and fails closed (not "running")', () => {
    const result = containerState({});
    expect(result).not.toBe('running');
    expect(result).toBe('');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'Unrecognized container status shape — orphan reaping may be skipping containers',
      { status: {} },
    );
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  function fakeContainer(id: string, status: string, installSlug?: string) {
    return {
      status,
      configuration: {
        id,
        labels: installSlug ? { 'nanoclaw-install': installSlug } : {},
      },
    };
  }

  it('asks container ls for JSON output', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} ls --format json`, expect.any(Object));
  });

  it('stops running containers labeled with this install slug', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        fakeContainer('nanoclaw-group1-111', 'running', INSTALL_SLUG),
        fakeContainer('nanoclaw-group2-222', 'running', INSTALL_SLUG),
      ]),
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('handles container 1.x object-shaped status ({ state })', () => {
    // container 1.0.0+ (ManagedResource) emits status as { state: 'running' }
    // instead of the bare 'running' string. Orphan cleanup must still match
    // the running one and skip the stopped one.
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        {
          status: { state: 'running' },
          configuration: { id: 'nanoclaw-v1-1', labels: { 'nanoclaw-install': INSTALL_SLUG } },
        },
        {
          status: { state: 'stopped' },
          configuration: { id: 'nanoclaw-v1-2', labels: { 'nanoclaw-install': INSTALL_SLUG } },
        },
      ]),
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 1,
      names: ['nanoclaw-v1-1'],
    });
  });

  it('skips peer installs (different label) and stopped containers', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        fakeContainer('nanoclaw-mine', 'running', INSTALL_SLUG),
        fakeContainer('nanoclaw-peer', 'running', 'some-other-install'),
        fakeContainer('nanoclaw-stopped', 'stopped', INSTALL_SLUG),
      ]),
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop nanoclaw-mine`, {
      stdio: 'pipe',
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        fakeContainer('nanoclaw-a-1', 'running', INSTALL_SLUG),
        fakeContainer('nanoclaw-b-2', 'running', INSTALL_SLUG),
      ]),
    );
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

// --- CONTAINER_HOST_GATEWAY() resolution precedence ---
//
// Regression coverage for the Apple Container 0.12.3 -> 1.1.0 bridge change:
// bridge100 disappeared, bridge0 lost its IPv4, and the subnet moved from
// 192.168.64.0/24 to 192.168.65.0/24. The old code hardcoded 192.168.64.1
// as a silent last resort, producing a dead gateway with no error anywhere.
//
// Each test re-imports the module fresh (vi.resetModules + dynamic import)
// because CONTAINER_HOST_GATEWAY() memoizes its result on first call —
// without a fresh module instance, later tests would just see the first
// test's cached value.
describe('CONTAINER_HOST_GATEWAY()', () => {
  beforeEach(() => {
    delete process.env.CONTAINER_HOST_GATEWAY;
    vi.resetModules();
    // mockReset() (not clearAllMocks) — clearAllMocks leaves queued
    // *Once implementations/return-values in place, which previously caused
    // state to leak between these tests (a later test silently consumed an
    // earlier test's unconsumed queued value). mockReset() wipes the queue.
    mockExecSync.mockReset();
    networkInterfacesSpy.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    delete process.env.CONTAINER_HOST_GATEWAY;
  });

  it('env override wins over everything, even when the runtime query would succeed', async () => {
    process.env.CONTAINER_HOST_GATEWAY = '10.0.0.1';
    mockExecSync.mockReturnValue(JSON.stringify([{ status: { ipv4Gateway: '192.168.65.1' } }]));

    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('10.0.0.1');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('parses `container network inspect default` JSON correctly', async () => {
    mockExecSync.mockReturnValue(JSON.stringify([{ status: { ipv4Gateway: '192.168.65.1' } }]));

    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('192.168.65.1');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${mod.CONTAINER_RUNTIME_BIN} network inspect default`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('memoizes: only queries the runtime once across repeated calls', async () => {
    mockExecSync.mockReturnValue(JSON.stringify([{ status: { ipv4Gateway: '192.168.65.1' } }]));

    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('192.168.65.1');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('192.168.65.1');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('malformed/empty runtime output falls through to the interface scan', async () => {
    mockExecSync.mockReturnValue('not json');
    networkInterfacesSpy.mockReturnValue({
      bridge100: [fakeIface('IPv4', '192.168.64.9')],
    });

    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('192.168.64.9');
  });

  it('bridge100 present -> uses its IPv4 (0.12.x path still works)', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('container: command not found');
    });
    networkInterfacesSpy.mockReturnValue({
      bridge100: [fakeIface('IPv6', 'fe80::1'), fakeIface('IPv4', '192.168.64.5')],
    });

    const mod = await import('./container-runtime.js');
    expect(mod.CONTAINER_HOST_GATEWAY()).toBe('192.168.64.5');
  });

  it('no bridge100, bridge0 has no IPv4, runtime command fails -> throws rather than returning a silent hardcoded address', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('container: command not found');
    });
    networkInterfacesSpy.mockReturnValue({
      bridge0: [fakeIface('IPv6', 'fe80::2')],
    });

    const mod = await import('./container-runtime.js');
    expect(() => mod.CONTAINER_HOST_GATEWAY()).toThrow(/Could not detect the container host gateway/);
    expect(log.error).toHaveBeenCalled();
  });
});
