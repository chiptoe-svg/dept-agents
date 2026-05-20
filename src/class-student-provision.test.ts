import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextStudentFolder } from './class-student-provision.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

function mkGroup(folder: string): void {
  createAgentGroup({
    id: `ag_${folder}`,
    name: folder,
    folder,
    agent_provider: 'codex',
    model: 'gpt-5.4-mini',
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
