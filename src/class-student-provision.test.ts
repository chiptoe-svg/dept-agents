import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextFolderForRole, nextStudentFolder } from './class-student-provision.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';

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
    expect(nextFolderForRole('user')).toBe('user_1');
    createAgentGroup({ id: 'ag_u1', name: 'x', folder: 'user_1', agent_provider: 'pi', created_at: '2026-01-01' });
    createAgentGroup({ id: 'ag_u4', name: 'y', folder: 'user_4', agent_provider: 'pi', created_at: '2026-01-01' });
    expect(nextFolderForRole('user')).toBe('user_5');
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
