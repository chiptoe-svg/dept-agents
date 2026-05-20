import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ContainerConfig.allowedModels', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-allowed-models-'));
    vi.doMock('./config.js', () => ({ GROUPS_DIR: tmp }));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('round-trips allowedModels through readContainerConfig/writeContainerConfig', async () => {
    const { readContainerConfig, writeContainerConfig } = await import('./container-config.js');
    writeContainerConfig('demo', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      allowedModels: [
        { provider: 'claude', model: 'claude-haiku-4-5' },
        { provider: 'ollama', model: 'llama-3.3-70b-instruct' },
      ],
    });
    const cfg = readContainerConfig('demo');
    expect(cfg.allowedModels).toEqual([
      { provider: 'claude', model: 'claude-haiku-4-5' },
      { provider: 'ollama', model: 'llama-3.3-70b-instruct' },
    ]);
  });

  it('returns undefined allowedModels when the file does not declare it', async () => {
    const { writeContainerConfig, readContainerConfig } = await import('./container-config.js');
    writeContainerConfig('demo', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });
    expect(readContainerConfig('demo').allowedModels).toBeUndefined();
  });
});
