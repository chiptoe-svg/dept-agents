import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-default-slot';
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-default-slot',
    GROUPS_DIR: '/tmp/nanoclaw-test-default-slot/groups',
  };
});

import {
  slotDir,
  slotExists,
  writeSlotConfig,
  readSlotConfig,
  writeSlotMeta,
  readSlotMeta,
} from './default-participant-slot.js';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('default-participant slot', () => {
  it('reports not-exists when nothing written', () => {
    expect(slotExists()).toBe(false);
    expect(readSlotConfig()).toBeNull();
    expect(readSlotMeta()).toBeNull();
  });

  it('round-trips the container config JSON', () => {
    writeSlotConfig({
      provider: 'pi',
      model: 'gpt-5.4-mini',
      model_provider: 'openai-codex',
      effort: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: 'all',
      mcp_servers: {},
      packages_apt: [],
      packages_npm: [],
      additional_mounts: [],
      env: {},
      allowed_models: [],
    });
    expect(fs.existsSync(path.join(slotDir(), 'container.json'))).toBe(true);
    const cfg = readSlotConfig()!;
    expect(cfg.provider).toBe('pi');
    expect(cfg.model_provider).toBe('openai-codex');
    expect(cfg.skills).toBe('all');
  });

  it('writes + reads meta and slotExists keys off meta.json', () => {
    expect(slotExists()).toBe(false);
    writeSlotMeta('owner:test');
    expect(slotExists()).toBe(true);
    const m = readSlotMeta()!;
    expect(m.savedBy).toBe('owner:test');
    expect(typeof m.savedAt).toBe('string');
  });
});
