/**
 * Unit tests for class-config helpers.
 *
 * The module reads `data/class-config.json` from DATA_DIR. We override
 * DATA_DIR via vi.mock to a tmp dir, write fixtures, and assert.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-class-config-test') };
});
const CONFIG_PATH = path.join(TEST_DIR, 'class-config.json');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  classRoleForFolder,
  findClassInstructor,
  findClassStudent,
  findClassTa,
  isClassFolder,
  isClassStudentFolder,
  readClassConfig,
} from './class-config.js';

interface MemberInput {
  name: string;
  folder: string;
}
interface ConfigInput {
  students: MemberInput[];
  tas?: MemberInput[];
  instructors?: MemberInput[];
}

function writeConfig(input: MemberInput[] | ConfigInput): void {
  const cfg: ConfigInput = Array.isArray(input) ? { students: input } : input;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        driveParent: 'parent-id',
        driveMountRoot: '/tmp/x',
        kb: null,
        wiki: null,
        students: cfg.students,
        tas: cfg.tas ?? [],
        instructors: cfg.instructors ?? [],
      },
      null,
      2,
    ),
  );
}

function clearConfig(): void {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('class-config helpers', () => {
  beforeEach(() => clearConfig());
  afterAll(() => clearConfig());

  describe('readClassConfig', () => {
    it('returns null when no class is provisioned', () => {
      expect(readClassConfig()).toBeNull();
    });

    it('parses a valid config blob', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      const cfg = readClassConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.students).toHaveLength(1);
      expect(cfg!.driveMountRoot).toBe('/tmp/x');
    });
  });

  describe('findClassStudent', () => {
    it('returns the student record for a known folder', () => {
      writeConfig([
        { name: 'Alice', folder: 'student_01' },
        { name: 'Bob', folder: 'student_02' },
      ]);
      expect(findClassStudent('student_02')).toEqual({ name: 'Bob', folder: 'student_02' });
    });

    it('returns null for an unknown folder', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(findClassStudent('student_99')).toBeNull();
    });

    it('returns null when no class is provisioned', () => {
      expect(findClassStudent('student_01')).toBeNull();
    });
  });

  describe('isClassStudentFolder', () => {
    it('is true for a folder in the class config', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(isClassStudentFolder('student_01')).toBe(true);
    });

    it('is false for a folder NOT in the class config', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(isClassStudentFolder('main')).toBe(false);
      expect(isClassStudentFolder('global')).toBe(false);
    });

    it('is false when no class is provisioned (default install)', () => {
      expect(isClassStudentFolder('student_01')).toBe(false);
    });

    it('is true for TA and instructor folders too (broad class match)', () => {
      writeConfig({
        students: [{ name: 'Alice', folder: 'student_01' }],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
        instructors: [{ name: 'Carol', folder: 'instructor_01' }],
      });
      expect(isClassStudentFolder('ta_01')).toBe(true);
      expect(isClassStudentFolder('instructor_01')).toBe(true);
    });
  });

  describe('readClassConfig with Phase 12 fields', () => {
    it('defaults tas + instructors to empty arrays when absent in JSON (back-compat)', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      const cfg = readClassConfig();
      expect(cfg!.tas).toEqual([]);
      expect(cfg!.instructors).toEqual([]);
    });

    it('parses tas + instructors when present', () => {
      writeConfig({
        students: [{ name: 'Alice', folder: 'student_01' }],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
        instructors: [
          { name: 'Carol', folder: 'instructor_01' },
          { name: 'Dave', folder: 'instructor_02' },
        ],
      });
      const cfg = readClassConfig();
      expect(cfg!.tas).toHaveLength(1);
      expect(cfg!.instructors).toHaveLength(2);
      expect(cfg!.instructors[1].name).toBe('Dave');
    });
  });

  describe('findClassTa', () => {
    it('returns the TA record when folder matches', () => {
      writeConfig({
        students: [],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
      });
      expect(findClassTa('ta_01')).toEqual({ name: 'Bob', folder: 'ta_01' });
    });

    it('returns null for an unknown TA folder', () => {
      writeConfig({ students: [], tas: [{ name: 'Bob', folder: 'ta_01' }] });
      expect(findClassTa('ta_99')).toBeNull();
    });

    it('returns null when no class is provisioned', () => {
      expect(findClassTa('ta_01')).toBeNull();
    });
  });

  describe('findClassInstructor', () => {
    it('returns the instructor record when folder matches', () => {
      writeConfig({
        students: [],
        instructors: [{ name: 'Carol', folder: 'instructor_01' }],
      });
      expect(findClassInstructor('instructor_01')).toEqual({ name: 'Carol', folder: 'instructor_01' });
    });

    it('returns null for an unknown instructor folder', () => {
      writeConfig({ students: [], instructors: [{ name: 'Carol', folder: 'instructor_01' }] });
      expect(findClassInstructor('instructor_99')).toBeNull();
    });
  });

  describe('isClassFolder', () => {
    it('matches across all three role lists', () => {
      writeConfig({
        students: [{ name: 'Alice', folder: 'student_01' }],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
        instructors: [{ name: 'Carol', folder: 'instructor_01' }],
      });
      expect(isClassFolder('student_01')).toBe(true);
      expect(isClassFolder('ta_01')).toBe(true);
      expect(isClassFolder('instructor_01')).toBe(true);
    });

    it('is false for non-class folders', () => {
      writeConfig({
        students: [{ name: 'Alice', folder: 'student_01' }],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
      });
      expect(isClassFolder('main')).toBe(false);
      expect(isClassFolder('student_99')).toBe(false);
      expect(isClassFolder('ta_99')).toBe(false);
    });
  });

  describe('classRoleForFolder', () => {
    it('returns the matching role', () => {
      writeConfig({
        students: [{ name: 'Alice', folder: 'student_01' }],
        tas: [{ name: 'Bob', folder: 'ta_01' }],
        instructors: [{ name: 'Carol', folder: 'instructor_01' }],
      });
      expect(classRoleForFolder('student_01')).toBe('student');
      expect(classRoleForFolder('ta_01')).toBe('ta');
      expect(classRoleForFolder('instructor_01')).toBe('instructor');
    });

    it("returns null when the folder isn't in any list", () => {
      writeConfig({ students: [{ name: 'Alice', folder: 'student_01' }] });
      expect(classRoleForFolder('main')).toBeNull();
      expect(classRoleForFolder('ta_01')).toBeNull();
    });

    it('returns null when no class is provisioned', () => {
      expect(classRoleForFolder('student_01')).toBeNull();
    });
  });
});
