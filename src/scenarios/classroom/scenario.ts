// Classroom scenario definition — the reference implementation of the Scenario
// contract. A skin over the canonical roles: owner→Instructor, assistant→TA,
// user→Student (classroom doesn't use it_admin). Role detection delegates to
// the existing class-config (config-based: which role array a folder is in).
//
// New scenarios (photo_lab, seminar, …) mirror this file with their own
// labels, personas, greetings, and folder convention.

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { classRoleForFolder, findClassInstructor, findClassStudent, findClassTa } from '../../class-config.js';
import { registerScenario } from '../registry.js';
import type { CanonicalRole, Scenario } from '../types.js';
import { INSTRUCTOR_PERSONA, STUDENT_PERSONA, TA_PERSONA } from './personas.js';

function readClassConfig(): Record<string, unknown> {
  const p = path.join(DATA_DIR, 'class-config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function appendStudentToClassConfig(student: { name: string; folder: string }): void {
  const p = path.join(DATA_DIR, 'class-config.json');
  const cfg = readClassConfig();
  const students = Array.isArray(cfg.students) ? (cfg.students as Array<{ folder?: string }>) : [];
  if (students.some((s) => s.folder === student.folder)) return;
  students.push(student);
  cfg.students = students;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

const classroom: Scenario = {
  name: 'classroom',
  roles: {
    owner: {
      label: 'Instructor',
      permission: 'global-admin',
      persona: INSTRUCTOR_PERSONA,
      greeting: (name) =>
        `Hi ${name}! You're set up as an instructor for this class. You have global admin — every agent group is reachable. Send /playground any time to customize.`,
    },
    assistant: {
      label: 'TA',
      permission: 'scoped-admin',
      persona: TA_PERSONA,
      greeting: (name) =>
        `Hi ${name}! You're set up as a TA. You have admin access to every student's agent group. Send /playground to customize your agent.`,
    },
    user: {
      label: 'Student',
      permission: 'member',
      persona: STUDENT_PERSONA,
      greeting: (name) =>
        `Hi ${name}! Welcome to class. Send /playground any time to customize my personality and style.`,
    },
  },
  // Classroom names come from the roster (class-config.json), regardless of role.
  memberName: (folder): string | null =>
    findClassStudent(folder)?.name ?? findClassTa(folder)?.name ?? findClassInstructor(folder)?.name ?? null,
  folderPrefix: { owner: 'instructor_', assistant: 'ta_', user: 'student_' },
  onMemberProvisioned: (folder, member) => {
    if (member.role === 'user') appendStudentToClassConfig({ name: member.name, folder });
  },
  // Classroom folders are config-listed under students/tas/instructors; map
  // the classroom role onto the canonical role.
  roleForFolder: (folder): CanonicalRole | null => {
    switch (classRoleForFolder(folder)) {
      case 'instructor':
        return 'owner';
      case 'ta':
        return 'assistant';
      case 'student':
        return 'user';
      default:
        return null;
    }
  },
};

registerScenario(classroom);
