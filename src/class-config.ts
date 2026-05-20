/**
 * Reader for `data/class-config.json` written by `scripts/class-skeleton.ts`.
 *
 * The pair handler uses this to detect class flow (wire-to a `student_*`
 * folder that the skeleton script provisioned), and Phase 3b uses it to
 * resolve `driveParent` for per-student folder creation.
 *
 * Returns null if the file is absent — no class has been provisioned yet.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface ClassMember {
  name: string;
  folder: string;
}

export interface ClassConfig {
  driveParent: string | null;
  driveMountRoot: string | null;
  kb: string | null;
  wiki: string | null;
  students: ClassMember[];
  /** TAs (Phase 12). Whole-class scope — every TA gets admin on every student. */
  tas: ClassMember[];
  /** Instructors (Phase 12). Multiple supported; each grants global admin on first pair. */
  instructors: ClassMember[];
}

const FILE_NAME = 'class-config.json';

export function readClassConfig(): ClassConfig | null {
  const p = path.join(DATA_DIR, FILE_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClassConfig>;
    if (!Array.isArray(parsed.students)) return null;
    return {
      driveParent: parsed.driveParent ?? null,
      driveMountRoot: parsed.driveMountRoot ?? null,
      kb: parsed.kb ?? null,
      wiki: parsed.wiki ?? null,
      students: parsed.students,
      tas: Array.isArray(parsed.tas) ? parsed.tas : [],
      instructors: Array.isArray(parsed.instructors) ? parsed.instructors : [],
    };
  } catch (err) {
    log.warn('class-config parse failed; treating as no class provisioned', { err: String(err) });
    return null;
  }
}

/** Look up the student record matching a folder name (e.g. "student_07"). */
export function findClassStudent(folder: string): ClassMember | null {
  const cfg = readClassConfig();
  if (!cfg) return null;
  return cfg.students.find((s) => s.folder === folder) ?? null;
}

/** Look up the TA record matching a folder name (e.g. "ta_03"). */
export function findClassTa(folder: string): ClassMember | null {
  const cfg = readClassConfig();
  if (!cfg) return null;
  return cfg.tas.find((t) => t.folder === folder) ?? null;
}

/** Look up the instructor record matching a folder name (e.g. "instructor_01"). */
export function findClassInstructor(folder: string): ClassMember | null {
  const cfg = readClassConfig();
  if (!cfg) return null;
  return cfg.instructors.find((i) => i.folder === folder) ?? null;
}

/**
 * True when the folder belongs to ANY provisioned class member —
 * student, TA, or instructor. Used by the playground gate to detect
 * class drafts (any class draft is class-aware regardless of role).
 */
export function isClassFolder(folder: string): boolean {
  const cfg = readClassConfig();
  if (!cfg) return false;
  return (
    cfg.students.some((s) => s.folder === folder) ||
    cfg.tas.some((t) => t.folder === folder) ||
    cfg.instructors.some((i) => i.folder === folder)
  );
}

/**
 * Backward-compatible alias for `isClassFolder`. Pre-Phase-12 callers
 * that only knew about students reach this; the broader matcher is
 * the right behavior for them too (TA/instructor folders should be
 * treated the same way in role-blind contexts).
 */
export function isClassStudentFolder(folder: string): boolean {
  return isClassFolder(folder);
}

export type ClassRole = 'student' | 'ta' | 'instructor';

/**
 * Determine which role a class folder belongs to. Returns null if
 * the folder isn't in the class config. Used by pair consumers to
 * dispatch role-specific behavior.
 */
export function classRoleForFolder(folder: string): ClassRole | null {
  const cfg = readClassConfig();
  if (!cfg) return null;
  if (cfg.students.some((s) => s.folder === folder)) return 'student';
  if (cfg.tas.some((t) => t.folder === folder)) return 'ta';
  if (cfg.instructors.some((i) => i.folder === folder)) return 'instructor';
  return null;
}
