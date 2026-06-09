import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { listLibrary } from './channels/playground/api/agent-library.js';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-default-participant',
    GROUPS_DIR: '/tmp/nanoclaw-test-default-participant/groups',
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { getAgentGroupByFolder, createAgentGroup } from './db/agent-groups.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
import {
  ensureTemplateAgent,
  saveDefaultFromTemplate,
  applyDefaultToAllParticipants,
  TEMPLATE_FOLDER,
} from './default-participant.js';
import { slotExists, readSlotConfig, slotDir } from './default-participant-slot.js';

const TMP = '/tmp/nanoclaw-test-default-participant';
const GROUPS = path.join(TMP, 'groups');

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  _resetScenariosForTest();
  registerScenario({
    name: 'stub',
    roles: { user: { label: 'P', permission: 'member', persona: (n) => `persona for ${n}`, greeting: (n) => n } },
    roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
    memberName: () => null,
    folderPrefix: { user: 'user_' },
  });
});
afterEach(() => {
  _resetScenariosForTest();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('applyDefaultToAllParticipants', () => {
  it('applies the default to user-role groups only, backs up + overwrites, returns count', () => {
    ensureTemplateAgent();
    fs.writeFileSync(path.join(GROUPS, TEMPLATE_FOLDER, 'CLAUDE.local.md'), '# DEFAULT\n');
    saveDefaultFromTemplate('owner:test');

    createAgentGroup({ id: 'ag_u1', name: 'A', folder: 'user_01', agent_provider: 'pi', created_at: '2026-01-01' });
    fs.mkdirSync(path.join(GROUPS, 'user_01'), { recursive: true });
    fs.writeFileSync(path.join(GROUPS, 'user_01', 'CLAUDE.local.md'), '# MINE\n');
    createAgentGroup({ id: 'ag_own', name: 'O', folder: 'owner_01', agent_provider: 'pi', created_at: '2026-01-01' });

    const res = applyDefaultToAllParticipants();
    expect(res.affected).toBe(1); // user_01 only — not owner_01, not the template
    expect(fs.readFileSync(path.join(GROUPS, 'user_01', 'CLAUDE.local.md'), 'utf8')).toBe('# DEFAULT\n');
    expect(res.restorePoints).toHaveLength(1);
    expect(res.restorePoints[0]).toMatch(/^pre-default-reset-/);
    expect(fs.existsSync(path.join(GROUPS, 'user_01', 'library', res.restorePoints[0]!))).toBe(true);
    const lib = listLibrary('user_01');
    expect(lib.some((e) => e.slug === res.restorePoints[0])).toBe(true); // restore point is UI-visible (has meta)
  });

  it('throws when no default saved', () => {
    expect(() => applyDefaultToAllParticipants()).toThrow(/no default/i);
  });
});

describe('default participant template', () => {
  it('ensureTemplateAgent creates the flagged template group once (idempotent)', () => {
    const a = ensureTemplateAgent();
    expect(getAgentGroupByFolder(TEMPLATE_FOLDER)?.id).toBe(a.id);
    expect(a.folder).toBe(TEMPLATE_FOLDER);
    const b = ensureTemplateAgent();
    expect(b.id).toBe(a.id); // idempotent, no duplicate
    // persona seeded
    expect(fs.readFileSync(path.join(GROUPS, TEMPLATE_FOLDER, 'CLAUDE.local.md'), 'utf8')).toContain(
      'persona for Participant',
    );
  });

  it('saveDefaultFromTemplate snapshots files + container config into the slot', () => {
    const ag = ensureTemplateAgent();
    fs.writeFileSync(path.join(GROUPS, TEMPLATE_FOLDER, 'CLAUDE.local.md'), '# custom persona\n');
    updateContainerConfigScalars(ag.id, { model: 'gpt-5.5' });
    saveDefaultFromTemplate('owner:test');
    expect(slotExists()).toBe(true);
    expect(fs.readFileSync(path.join(slotDir(), 'CLAUDE.local.md'), 'utf8')).toBe('# custom persona\n');
    expect(readSlotConfig()?.model).toBe('gpt-5.5');
  });
});
