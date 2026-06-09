import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextFolderForRole, nextStudentFolder } from './class-student-provision.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
import { writeSlotConfig, writeSlotMeta } from './default-participant-slot.js';

function mkGroup(folder: string): void {
  createAgentGroup({
    id: `ag_${folder}`,
    name: folder,
    folder,
    agent_provider: 'codex',
    created_at: new Date().toISOString(),
  });
}

describe('nextStudentFolder', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });
  afterEach(() => closeDb());

  it('returns student_01 on an empty class', () => {
    expect(nextStudentFolder()).toBe('student_01');
  });

  it('returns the next slot after a contiguous run of students', () => {
    mkGroup('student_01');
    mkGroup('student_02');
    mkGroup('student_03');
    expect(nextStudentFolder()).toBe('student_04');
  });

  it('uses highest+1 (gaps are not backfilled) and ignores non-student folders', () => {
    mkGroup('student_01');
    mkGroup('student_12');
    mkGroup('ta_01');
    mkGroup('instructor_01');
    mkGroup('dm-with-someone');
    expect(nextStudentFolder()).toBe('student_13');
  });

  it('zero-pads to two digits', () => {
    mkGroup('student_09');
    expect(nextStudentFolder()).toBe('student_10');
  });
});

describe('nextFolderForRole', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    _resetScenariosForTest();
    registerScenario({
      name: 'stub',
      roles: { user: { label: 'P', permission: 'member', persona: (n) => n, greeting: (n) => n } },
      roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
      memberName: () => null,
      folderPrefix: { user: 'user_' },
    });
  });
  afterEach(() => {
    _resetScenariosForTest();
    closeDb();
  });

  it('allocates the next folder using the active scenario prefix', () => {
    expect(nextFolderForRole('user')).toBe('user_01');
    createAgentGroup({ id: 'ag_u1', name: 'x', folder: 'user_1', agent_provider: 'pi', created_at: '2026-01-01' });
    createAgentGroup({ id: 'ag_u4', name: 'y', folder: 'user_4', agent_provider: 'pi', created_at: '2026-01-01' });
    expect(nextFolderForRole('user')).toBe('user_05');
  });
});

// provisionStudent writes both DB rows and an on-disk scaffold, so each
// test runs against a fresh module graph with GROUPS_DIR / DATA_DIR
// redirected into a temp dir (otherwise it would scribble into the repo).
describe('provisionStudent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-'));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(): Promise<{
    provisionStudent: typeof import('./class-student-provision.js').provisionStudent;
    nextStudentFolder: typeof import('./class-student-provision.js').nextStudentFolder;
    getAgentGroupByFolder: typeof import('./db/agent-groups.js').getAgentGroupByFolder;
    getUser: typeof import('./modules/permissions/db/users.js').getUser;
    isMember: typeof import('./modules/permissions/db/agent-group-members.js').isMember;
  }> {
    vi.resetModules();
    vi.doMock('./config.js', async () => ({
      ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
      GROUPS_DIR: path.join(tmp, 'groups'),
      DATA_DIR: path.join(tmp, 'data'),
    }));
    const dbMod = await import('./db/index.js');
    dbMod.runMigrations(dbMod.initTestDb());
    // provisionStudent now delegates to provisionMember → nextFolderForRole,
    // which requires an active scenario with a 'user' folder prefix.
    const registry = await import('./scenarios/registry.js');
    registry._resetScenariosForTest();
    registry.registerScenario({
      name: 'stub-student',
      roles: { user: { label: 'Student', permission: 'member', persona: (n) => `Student ${n}`, greeting: (n) => n } },
      roleForFolder: (f) => (f.startsWith('student_') ? 'user' : null),
      memberName: () => null,
      folderPrefix: { user: 'student_' },
    });
    const provision = await import('./class-student-provision.js');
    const groups = await import('./db/agent-groups.js');
    const users = await import('./modules/permissions/db/users.js');
    const members = await import('./modules/permissions/db/agent-group-members.js');
    return {
      provisionStudent: provision.provisionStudent,
      nextStudentFolder: provision.nextStudentFolder,
      getAgentGroupByFolder: groups.getAgentGroupByFolder,
      getUser: users.getUser,
      isMember: members.isMember,
    };
  }

  it('writes the four DB rows and the on-disk scaffold', async () => {
    const s = await setup();
    const result = s.provisionStudent({ name: 'Ada Lovelace', email: 'ada@example.edu', addedBy: null });

    // Folder comes from nextFolderForRole('user') → 'student_01' (zero-padded to 2 digits).
    expect(result.folder).toBe('student_01');
    expect(result.userId).toBe('class:student_01');
    expect(s.getAgentGroupByFolder('student_01')).toBeTruthy();
    expect(s.getUser('class:student_01')).toBeTruthy();
    expect(s.isMember('class:student_01', result.agentGroupId)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'groups', 'student_01', 'CLAUDE.local.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'groups', 'student_01', 'container.json'))).toBe(true);
  });

  it('rolls the DB rows back when the on-disk scaffold fails', async () => {
    const s = await setup();
    // Plant a regular file where the student_01 directory must go, so the
    // scaffold's mkdirSync throws after the DB transaction has committed.
    fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'groups', 'student_01'), 'not a directory');

    expect(() => s.provisionStudent({ name: 'Bad', email: 'bad@example.edu', addedBy: null })).toThrow();

    // The committed rows must be gone, so a retry reissues the same slot.
    expect(s.getAgentGroupByFolder('student_01')).toBeUndefined();
    expect(s.getUser('class:student_01')).toBeUndefined();
    expect(s.nextStudentFolder()).toBe('student_01');
  });
});

describe('provisionMember', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-member-'));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(): Promise<{
    provisionMember: typeof import('./class-student-provision.js').provisionMember;
    GROUPS_DIR: string;
    DATA_DIR: string;
    getContainerConfig: typeof import('./db/container-configs.js').getContainerConfig;
  }> {
    vi.resetModules();
    const groupsDir = path.join(tmp, 'groups');
    const dataDir = path.join(tmp, 'data');
    vi.doMock('./config.js', async () => ({
      ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
      GROUPS_DIR: groupsDir,
      DATA_DIR: dataDir,
    }));
    const dbMod = await import('./db/index.js');
    dbMod.runMigrations(dbMod.initTestDb());
    // Register a stub scenario with user_ prefix so nextFolderForRole works.
    const registry = await import('./scenarios/registry.js');
    registry._resetScenariosForTest();
    registry.registerScenario({
      name: 'stub',
      roles: { user: { label: 'P', permission: 'member', persona: (n) => `Persona for ${n}`, greeting: (n) => n } },
      roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
      memberName: () => null,
      folderPrefix: { user: 'user_' },
    });
    const provision = await import('./class-student-provision.js');
    const cfgs = await import('./db/container-configs.js');
    return {
      provisionMember: provision.provisionMember,
      GROUPS_DIR: groupsDir,
      DATA_DIR: dataDir,
      getContainerConfig: cfgs.getContainerConfig,
    };
  }

  it('provisions a user-role member from the slot when present', async () => {
    const s = await setup();
    // Write slot files into the mocked DATA_DIR location.
    const slotPath = path.join(s.DATA_DIR, 'config', 'default-participant');
    fs.mkdirSync(slotPath, { recursive: true });
    fs.writeFileSync(path.join(slotPath, 'CLAUDE.local.md'), '# Template persona\n');
    fs.writeFileSync(path.join(slotPath, 'CLAUDE.md'), '# Template CLAUDE\n');
    // Write slot config and meta directly (bypass module-level slotDir() binding).
    fs.writeFileSync(
      path.join(slotPath, 'container.json'),
      JSON.stringify({
        provider: 'pi',
        model: 'gpt-5.4-mini',
        model_provider: 'openai',
        effort: null,
        assistant_name: null,
        max_messages_per_prompt: null,
        skills: ['web'],
        mcp_servers: {},
        packages_apt: [],
        packages_npm: [],
        additional_mounts: [],
        env: {},
        allowed_models: [],
      }),
    );
    fs.writeFileSync(
      path.join(slotPath, 'meta.json'),
      JSON.stringify({ savedAt: new Date().toISOString(), savedBy: 'owner:test' }),
    );

    const r = s.provisionMember({ role: 'user', name: 'Dana', email: 'dana@x.edu', addedBy: null });
    expect(r.folder).toBe('user_01');
    expect(r.agentGroupId).toBeTruthy();
    const persona = fs.readFileSync(path.join(s.GROUPS_DIR, r.folder, 'CLAUDE.local.md'), 'utf8');
    expect(persona).toBe('# Template persona\n');
    const cfg = s.getContainerConfig(r.agentGroupId)!;
    expect(cfg.provider).toBe('pi');
    expect(JSON.parse(cfg.skills as string)).toEqual(['web']);
  });

  it('falls back to roleProfile persona + fixed skills when no slot exists', async () => {
    const s = await setup();
    // No slot written — slotExists() returns false.
    const r = s.provisionMember({ role: 'user', name: 'Eve', email: 'eve@x.edu', addedBy: null });
    const cfg = s.getContainerConfig(r.agentGroupId)!;
    // No slot → skills defaults to 'all', NOT inherited from owner.
    expect(JSON.parse(cfg.skills as string)).toBe('all');
    // Persona from stub scenario's persona() function.
    const persona = fs.readFileSync(path.join(s.GROUPS_DIR, r.folder, 'CLAUDE.local.md'), 'utf8');
    expect(persona).toBe('Persona for Eve');
  });
});
