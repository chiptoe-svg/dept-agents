/**
 * Regression test for the container-token lifecycle fix in
 * src/container-runner.ts: the close/error handlers that revoke the
 * per-container token must be attached *before* any bookkeeping that can
 * throw (markContainerRunning is a central-DB write). Otherwise a mid-spawn
 * throw leaves a live container running with no exit listener attached, and
 * revokeContainerToken never fires — the token (a credential) survives until
 * host restart.
 *
 * This drives the real, unexported `spawnContainer()` end to end (via the
 * exported `wakeContainer()`), with every dependency that would otherwise
 * touch the real DB or the real `groups/`/`data/` trees mocked or redirected
 * into an ephemeral tmp dir. `container-identity.js` is deliberately left
 * mostly real (wrapped only to capture the minted token) so the test
 * observes genuine mint -> resolve -> revoke behavior, not a re-implementation
 * of it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Hoisted fixtures (must exist before any vi.mock factory runs) ----

const mocks = vi.hoisted(() => ({
  getAgentGroup: vi.fn(),
  materializeContainerJson: vi.fn(),
  sessionDir: vi.fn(),
  heartbeatPath: vi.fn(),
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  writeSessionRouting: vi.fn(),
  stopTypingRefresh: vi.fn(),
  spawn: vi.fn(),
}));

const capture = vi.hoisted(() => ({ token: undefined as string | undefined }));

const configOverrides = vi.hoisted(() => {
  const suffix = `${process.pid}-${Date.now()}`;
  return {
    dataDir: `/tmp/nanoclaw-crtest-data-${suffix}`,
    groupsDir: `/tmp/nanoclaw-crtest-groups-${suffix}`,
    sitesDir: `/tmp/nanoclaw-crtest-sites-${suffix}`,
  };
});

// ---- Module mocks ----

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// Redirect the path roots container-runner.ts writes under (DATA_DIR for
// .claude-shared skill symlinks, GROUPS_DIR for the group folder, SITES_DIR
// for the make-website mount) into an ephemeral tmp dir so this test never
// touches the real project's groups/, data/, or Homebrew sites trees.
// Everything else in config.js stays real.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    DATA_DIR: configOverrides.dataDir,
    GROUPS_DIR: configOverrides.groupsDir,
    SITES_DIR: configOverrides.sitesDir,
  };
});

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mocks.getAgentGroup(...args),
}));

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => ({})),
  hasTable: vi.fn(() => false),
}));

vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: vi.fn(() => null),
  updateContainerConfigScalars: vi.fn(),
}));

vi.mock('./container-config.js', () => ({
  materializeContainerJson: (...args: unknown[]) => mocks.materializeContainerJson(...args),
  containerConfigPath: vi.fn(() => path.join(os.tmpdir(), 'nanoclaw-crtest-unused-container-config.json')),
}));

vi.mock('./group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
}));

vi.mock('./claude-md-compose.js', () => ({
  composeGroupClaudeMd: vi.fn(),
}));

vi.mock('./session-manager.js', () => ({
  heartbeatPath: (...args: unknown[]) => mocks.heartbeatPath(...args),
  markContainerRunning: (...args: unknown[]) => mocks.markContainerRunning(...args),
  markContainerStopped: (...args: unknown[]) => mocks.markContainerStopped(...args),
  sessionDir: (...args: unknown[]) => mocks.sessionDir(...args),
  writeSessionRouting: (...args: unknown[]) => mocks.writeSessionRouting(...args),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./web-search-config.js', () => ({
  readWebSearchProvider: vi.fn(() => 'brave'),
  readSearxngUrl: vi.fn(() => null),
  readBraveApiKey: vi.fn(() => null),
}));

vi.mock('./container-env-registry.js', () => ({
  collectContainerEnv: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: vi.fn(() => 'test-gateway'),
  CONTAINER_RUNTIME_BIN: 'test-container-bin',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(),
}));

vi.mock('./modules/typing/index.js', () => ({
  stopTypingRefresh: (...args: unknown[]) => mocks.stopTypingRefresh(...args),
}));

// Keep container-identity.js's real mint/resolve/revoke behavior (it's the
// thing under test's contract, not something to fake) — just capture the
// minted token so the test can observe it without knowing the random value.
vi.mock('./container-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-identity.js')>();
  return {
    ...actual,
    mintContainerToken: (agentGroupId: string, sessionId: string) => {
      const token = actual.mintContainerToken(agentGroupId, sessionId);
      capture.token = token;
      return token;
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => mocks.spawn(...args) };
});

// ---- Imports of the modules under test (after all vi.mock calls) ----

import { wakeContainer } from './container-runner.js';
import { resolveContainerToken, _resetForTest } from './container-identity.js';
import type { AgentGroup, Session } from './types.js';

function fakeChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

const AGENT_GROUP: AgentGroup = {
  id: 'group-token-lifecycle',
  name: 'Token Lifecycle Group',
  folder: 'token-lifecycle-group',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

// Each test gets its own session id. `activeContainers` in container-runner.ts
// is module-level singleton state that outlives individual tests within this
// file — reusing one session id would let a leaked entry from one test (e.g.
// the very bug under test: a stale entry left behind because the exit
// handlers never got attached) make `wakeContainer` short-circuit as
// "already running" in a later test, masking the very failure it's supposed
// to prove.
let sessionCounter = 0;
function makeSession(): Session {
  sessionCounter += 1;
  return {
    id: `session-token-lifecycle-${sessionCounter}`,
    agent_group_id: AGENT_GROUP.id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('container token lifecycle (Fix 1 regression)', () => {
  let tmpSessionDir: string;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call
    // history, leaving a mockImplementation set by an earlier test (e.g.
    // markContainerRunning throwing) to leak into the next test.
    vi.resetAllMocks();
    _resetForTest();
    capture.token = undefined;

    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-crtest-session-'));
    mocks.sessionDir.mockReturnValue(tmpSessionDir);
    mocks.heartbeatPath.mockReturnValue(path.join(tmpSessionDir, '.heartbeat'));
    mocks.getAgentGroup.mockReturnValue(AGENT_GROUP);
    mocks.materializeContainerJson.mockReturnValue({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
      provider: 'claude',
      groupName: AGENT_GROUP.name,
      assistantName: AGENT_GROUP.name,
      agentGroupId: AGENT_GROUP.id,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpSessionDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(configOverrides.dataDir, { recursive: true, force: true });
    fs.rmSync(configOverrides.groupsDir, { recursive: true, force: true });
    fs.rmSync(configOverrides.sitesDir, { recursive: true, force: true });
  });

  it('revokes the token on close, even when markContainerRunning throws mid-spawn', async () => {
    mocks.markContainerRunning.mockImplementation(() => {
      throw new Error('central-DB write failed');
    });
    const child = fakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    const session = makeSession();

    const ok = await wakeContainer(session);

    // spawnContainer rejected (markContainerRunning threw) — wakeContainer's
    // contract is to swallow that and return false, never throw.
    expect(ok).toBe(false);
    expect(capture.token).toBeDefined();
    // Token is still live — the container hasn't exited yet.
    expect(resolveContainerToken(capture.token!)).not.toBeNull();

    child.emit('close', 0);

    expect(resolveContainerToken(capture.token!)).toBeNull();
    expect(mocks.markContainerStopped).toHaveBeenCalledWith(session.id);
    expect(mocks.stopTypingRefresh).toHaveBeenCalledWith(session.id);
  });

  it('revokes the token on error, even when markContainerRunning throws mid-spawn', async () => {
    mocks.markContainerRunning.mockImplementation(() => {
      throw new Error('central-DB write failed');
    });
    const child = fakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    const session = makeSession();

    await wakeContainer(session);
    expect(capture.token).toBeDefined();
    expect(resolveContainerToken(capture.token!)).not.toBeNull();

    child.emit('error', new Error('spawn ENOENT'));

    expect(resolveContainerToken(capture.token!)).toBeNull();
  });

  it('still revokes the token on close in the ordinary (non-throwing) path', async () => {
    const child = fakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    const session = makeSession();

    const ok = await wakeContainer(session);
    expect(ok).toBe(true);
    expect(capture.token).toBeDefined();

    child.emit('close', 0);

    expect(resolveContainerToken(capture.token!)).toBeNull();
  });
});
