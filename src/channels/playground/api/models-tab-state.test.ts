import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveProviderState } from './models-tab-state.js';
import type { SpecFacts } from './models-tab-state.js';

const baseSpec: SpecFacts = {
  id: 'test',
  displayName: 'Test',
  catalogModels: [],
  hasReachabilityProbe: false,
  isLocalOnly: false,
  hasOauthMethod: false,
  hasApiKeyMethod: true,
};

const allow = { allow: true, provideDefault: false, allowByo: false };
const noCreds = { hasOAuth: false, hasApiKey: false };
const ownOauth = { hasOAuth: true, hasApiKey: false };

describe('deriveProviderState — truth table', () => {
  it('HIDDEN when policy.allow=false', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allow: false },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('HIDDEN');
  });

  it('GREYED + "test connection" when local-only and unreachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow,
      creds: noCreds,
      reachable: false,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('test connection');
  });

  it('AVAILABLE (source local) when local-only and reachable', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasReachabilityProbe: true, isLocalOnly: true },
      policy: allow,
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('local');
  });

  it('AVAILABLE (source class-pool) when provideDefault=true', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, provideDefault: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('class-pool');
  });

  it('AVAILABLE (source personal-oauth) when student has OAuth', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allowByo: true },
      creds: ownOauth,
      reachable: true,
    });
    expect(r.state).toBe('AVAILABLE');
    expect(r.source).toBe('personal-oauth');
  });

  it('GREYED + "add api key" when allowByo=true and no creds and apiKey method', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: { ...allow, allowByo: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('add api key');
  });

  it('GREYED + "connect" when allowByo=true, oauth method, no creds', () => {
    const r = deriveProviderState({
      spec: { ...baseSpec, hasOauthMethod: true, hasApiKeyMethod: false },
      policy: { ...allow, allowByo: true },
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('connect');
  });

  it('GREYED + "ask instructor" when allow=true but no fallbacks', () => {
    const r = deriveProviderState({
      spec: baseSpec,
      policy: allow,
      creds: noCreds,
      reachable: true,
    });
    expect(r.state).toBe('GREYED');
    expect(r.actionLabel).toBe('ask instructor');
  });
});

// ---------------------------------------------------------------------------
// Integration test — handleGetModelsTabState
// ---------------------------------------------------------------------------

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  // Reset module cache so PROJECT_ROOT / CONFIG_PATH re-evaluate against tmpRoot.
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('handleGetModelsTabState — integration', () => {
  it('returns one entry per registered provider with the documented shape', async () => {
    // Seed two providers into the auth registry.
    const { registerProvider, resetRegistryForTests } = await import('../../../providers/auth-registry.js');
    resetRegistryForTests();
    registerProvider({
      id: 'claude',
      displayName: 'Claude',
      proxyRoutePrefix: '',
      credentialFileShape: 'oauth-token',
      apiKey: { placeholder: 'sk-ant-…' },
    });
    registerProvider({
      id: 'openai-platform',
      displayName: 'OpenAI',
      proxyRoutePrefix: '/openai/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'sk-…' },
    });

    // Write class controls: claude is allowed+provideDefault; openai-platform allowByo only.
    const { writeClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    writeClassControls({
      classes: {
        [DEFAULT_CLASS_ID]: {
          tabsVisibleToStudents: ['models'],
          authModesAvailable: ['api-key'],
          providers: {
            claude: { allow: true, provideDefault: true, allowByo: false },
            'openai-platform': { allow: true, provideDefault: false, allowByo: true },
          },
        },
      },
    });

    // Seed an owner with a claude credential so classPoolReady=true. The
    // class-pool path returns AVAILABLE only when the instructor actually
    // has creds for the spec — see deriveProviderState's classPoolReady gate.
    vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
      getOwnerUserId: () => 'owner:test',
    }));
    const { addApiKey } = await import('../../../user-provider-auth.js');
    addApiKey('owner:test', 'claude', 'sk-ant-instructor');

    // Student has no personal creds (no cred files in tmpRoot/data/).
    const { handleGetModelsTabState } = await import('./models-tab-state.js');
    const res = await handleGetModelsTabState({
      userId: 'user:test',
      agentGroupId: 'ag-test',
      classId: DEFAULT_CLASS_ID,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      providers: Array<{
        id: string;
        state: string;
        source: unknown;
        actionLabel: unknown;
        catalogModels: Array<unknown>;
        displayName: string;
      }>;
    };
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers).toHaveLength(2);

    // Confirm every provider object has the documented shape.
    for (const p of body.providers) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('displayName');
      expect(p).toHaveProperty('state');
      expect(p).toHaveProperty('source');
      expect(p).toHaveProperty('actionLabel');
      expect(p).toHaveProperty('catalogModels');
      if (p.state === 'HIDDEN') expect(p.catalogModels).toHaveLength(0);
    }

    // claude: provideDefault → AVAILABLE source=class-pool
    const claude = body.providers.find((p) => p.id === 'claude')!;
    expect(claude.state).toBe('AVAILABLE');
    expect(claude.source).toBe('class-pool');

    // openai-platform: allowByo, no creds, apiKey method → GREYED + "add api key"
    const openai = body.providers.find((p) => p.id === 'openai-platform')!;
    expect(openai.state).toBe('GREYED');
    expect(openai.actionLabel).toBe('add api key');
  });
});
