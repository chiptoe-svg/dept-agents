import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  });

  it('reads .state from an object (container 1.x)', () => {
    expect(containerState({ state: 'running' })).toBe('running');
  });

  it('does not throw on undefined and fails closed (not "running")', () => {
    expect(containerState(undefined)).not.toBe('running');
  });

  it('does not throw on null and fails closed (not "running")', () => {
    expect(containerState(null)).not.toBe('running');
  });

  it('does not throw on a non-string state and fails closed (not "running")', () => {
    expect(containerState({ state: 123 })).not.toBe('running');
  });

  it('does not throw on an object with no state key and fails closed (not "running")', () => {
    expect(containerState({})).not.toBe('running');
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
