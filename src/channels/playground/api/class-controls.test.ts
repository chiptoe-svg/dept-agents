import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  // Reset module cache so `PROJECT_ROOT = process.cwd()` in src/config.ts
  // re-evaluates against the per-test tmpRoot. Without this, the second
  // test sees CONFIG_PATH frozen against the first test's (now deleted)
  // tmp directory.
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('class-controls — new wrapped shape', () => {
  it('returns default providers map when no file exists (fresh class)', async () => {
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    const providers = cc.classes[DEFAULT_CLASS_ID]!.providers;
    expect(providers).toHaveProperty('claude');
    expect(providers).toHaveProperty('codex');
    expect(providers).toHaveProperty('openai-platform');
    expect(providers).toHaveProperty('omlx');
    expect(providers['omlx']).toEqual({ allow: true, provideDefault: true, allowByo: false });
  });

  it('migrates v1 flat shape — only listed providers appear in map', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        tabsVisibleToStudents: ['home', 'chat'],
        providersAvailable: ['claude', 'codex'],
        authModesAvailable: ['api-key'],
      }),
    );
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID]!.tabsVisibleToStudents).toEqual(['home', 'chat']);
    // Listed providers: migrated to Mode A (allow+default, no BYO)
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.claude).toEqual({
      allow: true,
      provideDefault: true,
      allowByo: false,
    });
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.codex).toEqual({
      allow: true,
      provideDefault: true,
      allowByo: false,
    });
    // 'local' was NOT in the v1 array → NOT in the map at all
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.local).toBeUndefined();
  });

  it('migrates v1 flat shape with empty providersAvailable → empty providers map', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        tabsVisibleToStudents: [],
        providersAvailable: [],
        authModesAvailable: ['api-key'],
      }),
    );
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers).toEqual({});
  });

  it('round-trips through write+read', async () => {
    const { readClassControls, writeClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const before = readClassControls();
    before.classes[DEFAULT_CLASS_ID]!.providers.claude = { allow: true, provideDefault: true, allowByo: false };
    writeClassControls(before);
    const after = readClassControls();
    expect(after.classes[DEFAULT_CLASS_ID]!.providers.claude!.provideDefault).toBe(true);
  });

  it('handlePutClassControls rejects writes to non-default class IDs in v1', async () => {
    const { handlePutClassControls } = await import('./class-controls.js');
    const result = handlePutClassControls({
      classes: { 'fake-class': { tabsVisibleToStudents: [], authModesAvailable: [], providers: {} } },
    } as never);
    expect(result.status).toBe(400);
  });
});

describe('Class Controls — new provider defaults (mptab-14)', () => {
  it('DEFAULT_CLASS_CONTROL includes openai-platform and omlx', async () => {
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    const providers = cc.classes[DEFAULT_CLASS_ID]!.providers;
    expect(providers).toHaveProperty('openai-platform');
    expect(providers).toHaveProperty('omlx');
    expect(providers['openai-platform']).toEqual({ allow: false, provideDefault: false, allowByo: false });
    expect(providers['omlx']).toEqual({ allow: true, provideDefault: true, allowByo: false });
  });

  it('reading a pre-existing config with only claude+codex preserves those policies', async () => {
    // Write a config that only has the old 2 providers
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        classes: {
          default: {
            tabsVisibleToStudents: ['chat'],
            authModesAvailable: ['api-key'],
            providers: {
              claude: { allow: true, provideDefault: true, allowByo: true },
              codex: { allow: true, provideDefault: false, allowByo: true },
            },
          },
        },
      }),
    );

    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    const providers = cc.classes[DEFAULT_CLASS_ID]!.providers;
    // Existing providers preserved verbatim
    expect(providers.claude).toEqual({ allow: true, provideDefault: true, allowByo: true });
    expect(providers.codex).toEqual({ allow: true, provideDefault: false, allowByo: true });
    // New providers are NOT auto-filled on read (they stay absent from the old config).
    // The greying rule in handleGetModelsTabState already defaults missing policies
    // to {allow:false, provideDefault:false, allowByo:false} so this is safe.
    expect(providers['openai-platform']).toBeUndefined();
    expect(providers['omlx']).toBeUndefined();
  });
});
