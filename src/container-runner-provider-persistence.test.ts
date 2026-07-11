/**
 * Regression test for the composeGroupClaudeMd clobber-ordering bug in
 * src/container-runner.ts (spawnContainer): ensureRuntimeFields() writes the
 * resolved `provider` field into container.json, but historically ran
 * *before* buildMounts() — and buildMounts() calls composeGroupClaudeMd(),
 * which independently re-materializes container.json straight from the DB
 * row (which may not have `provider` synced, e.g. it's only set at the
 * agent_groups level, not yet backfilled into container_configs). Whichever
 * write lands last wins on disk, so the old ordering let the DB-only
 * re-materialize clobber the resolved provider, leaving container.json
 * without a `provider` field.
 *
 * Symptom in production: the container dies at startup with a misleading
 * "Module not found /app/src/index.ts" because the runner can't tell which
 * harness to launch.
 *
 * This drives the real, unexported `spawnContainer()` end to end (via the
 * exported `wakeContainer()`), keeping `container-config.js` and
 * `claude-md-compose.js` REAL (unlike container-token-lifecycle.test.ts,
 * which mocks both away) so the actual double-materialize race is observed.
 * Every other dependency that would touch the real DB or the real
 * groups//data/ trees is mocked or redirected into an ephemeral tmp dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Hoisted fixtures (must exist before any vi.mock factory runs) ----

const mocks = vi.hoisted(() => ({
  getAgentGroup: vi.fn(),
  getContainerConfig: vi.fn(),
  sessionDir: vi.fn(),
  heartbeatPath: vi.fn(),
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  writeSessionRouting: vi.fn(),
  stopTypingRefresh: vi.fn(),
  spawn: vi.fn(),
}));

const configOverrides = vi.hoisted(() => {
  const suffix = `${process.pid}-${Date.now()}-provider-persist`;
  return {
    dataDir: `/tmp/nanoclaw-crtest-data-${suffix}`,
    groupsDir: `/tmp/nanoclaw-crtest-groups-${suffix}`,
    // buildMounts() (via wakeContainer -> spawnContainer) mkdirs + mounts
    // SITES_DIR/<folder> for the make-website skill. Redirect it into
    // the same ephemeral tmp tree — without this override it would
    // silently create a real directory under the developer's actual
    // /opt/homebrew/var/www/sites on any machine that has it set up.
    sitesDir: `/tmp/nanoclaw-crtest-sites-${suffix}`,
  };
});

// ---- Module mocks ----
// Deliberately does NOT mock ./container-config.js or ./claude-md-compose.js
// — those are the real code under test.

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

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
  getContainerConfig: (...args: unknown[]) => mocks.getContainerConfig(...args),
  updateContainerConfigScalars: vi.fn(),
}));

vi.mock('./group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => mocks.spawn(...args) };
});

// ---- Imports of the modules under test (after all vi.mock calls) ----

import { wakeContainer } from './container-runner.js';
import { containerConfigPath } from './container-config.js';
import { _resetForTest } from './container-identity.js';
import type { AgentGroup, Session } from './types.js';

function fakeChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

// agent_provider is set at the group level ('opencode' — deliberately *not*
// a name registered in this trunk's provider-container-registry, so
// getProviderContainerConfig() returns undefined and the contribution is
// {} — keeps this test from touching real .env / auth files) but the
// container_configs row (below) has provider: null, simulating a group
// whose DB-level provider hasn't been backfilled into container_configs
// yet. This is exactly the state that reproduces the clobber.
const AGENT_GROUP: AgentGroup = {
  id: 'group-provider-persist',
  name: 'Provider Persist Group',
  folder: 'provider-persist-group',
  agent_provider: 'opencode',
  created_at: new Date().toISOString(),
};

function makeContainerConfigRow() {
  return {
    agent_group_id: AGENT_GROUP.id,
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '[]',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    env: '{}',
    allowed_models: '[]',
    model_provider: null,
  };
}

let sessionCounter = 0;
function makeSession(): Session {
  sessionCounter += 1;
  return {
    id: `session-provider-persist-${sessionCounter}`,
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

describe('container.json provider survives composeGroupClaudeMd (Fix: clobber ordering)', () => {
  let tmpSessionDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    _resetForTest();

    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-crtest-provider-persist-'));
    mocks.sessionDir.mockReturnValue(tmpSessionDir);
    mocks.heartbeatPath.mockReturnValue(path.join(tmpSessionDir, '.heartbeat'));
    mocks.getAgentGroup.mockReturnValue(AGENT_GROUP);
    mocks.getContainerConfig.mockReturnValue(makeContainerConfigRow());
  });

  afterEach(() => {
    fs.rmSync(tmpSessionDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(configOverrides.dataDir, { recursive: true, force: true });
    fs.rmSync(configOverrides.groupsDir, { recursive: true, force: true });
    fs.rmSync(configOverrides.sitesDir, { recursive: true, force: true });
  });

  it('writes a non-empty provider to the materialized container.json after spawn', async () => {
    const child = fakeChildProcess();
    mocks.spawn.mockReturnValue(child);
    const session = makeSession();

    const ok = await wakeContainer(session);
    expect(ok).toBe(true);

    const written = JSON.parse(fs.readFileSync(containerConfigPath(AGENT_GROUP.folder), 'utf8')) as {
      provider?: string;
    };

    // The resolved provider (from agent_groups.agent_provider, since the
    // container_configs row's own `provider` column is null) must survive
    // composeGroupClaudeMd's internal re-materialize.
    expect(written.provider).toBeTruthy();
    expect(written.provider).toBe('opencode');
  });
});
