import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEffectivePersonaLayers', () => {
  let tmp: string;
  let groupsDir: string;
  let containerDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-layers-'));
    groupsDir = path.join(tmp, 'groups');
    containerDir = path.join(tmp, 'container');
    fs.mkdirSync(groupsDir);
    fs.mkdirSync(containerDir);
    vi.doMock('./config.js', () => ({ GROUPS_DIR: groupsDir, CONTAINER_DIR: containerDir }));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns all four layers when files exist', async () => {
    const groupDir = path.join(groupsDir, 'demo');
    fs.mkdirSync(groupDir);
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'my persona');
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '@./fragment.md');
    fs.writeFileSync(path.join(groupDir, 'fragment.md'), 'group base body');
    fs.writeFileSync(path.join(containerDir, 'CLAUDE.md'), 'container base');
    fs.mkdirSync(path.join(groupsDir, 'global'));
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), 'global base');

    const { getEffectivePersonaLayers } = await import('./persona-layers.js');
    const layers = getEffectivePersonaLayers('demo');
    expect(layers.myPersona).toBe('my persona');
    expect(layers.groupBase).toBe('group base body');
    expect(layers.containerBase).toBe('container base');
    expect(layers.global).toBe('global base');
  });

  it('omits global when groups/global/CLAUDE.md is absent', async () => {
    fs.mkdirSync(path.join(groupsDir, 'demo'));
    fs.writeFileSync(path.join(groupsDir, 'demo', 'CLAUDE.local.md'), '');
    fs.writeFileSync(path.join(groupsDir, 'demo', 'CLAUDE.md'), '');
    fs.writeFileSync(path.join(containerDir, 'CLAUDE.md'), '');

    const { getEffectivePersonaLayers } = await import('./persona-layers.js');
    expect(getEffectivePersonaLayers('demo').global).toBeUndefined();
  });

  it('returns empty strings (not throws) when group files are missing', async () => {
    fs.mkdirSync(path.join(groupsDir, 'demo'));
    fs.writeFileSync(path.join(containerDir, 'CLAUDE.md'), 'container');

    const { getEffectivePersonaLayers } = await import('./persona-layers.js');
    const layers = getEffectivePersonaLayers('demo');
    expect(layers.myPersona).toBe('');
    expect(layers.groupBase).toBe('');
    expect(layers.containerBase).toBe('container');
  });
});
