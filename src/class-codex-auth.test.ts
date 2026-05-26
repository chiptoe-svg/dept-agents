/**
 * Tests for the class-shared Codex auth resolver (Mode A LLM pool).
 *
 * Verifies the resolver's branching behavior:
 *   - Returns the class auth.json path for class agent groups when the
 *     file exists.
 *   - Returns null for non-class agent groups.
 *   - Returns null for class agent groups when the file is missing
 *     (caller chain falls through to instructorHostResolver).
 *   - Returns null when the agent group doesn't exist in the DB.
 *
 * The `initializeClassAuth` side effect (reading .env + writing the
 * class auth.json) is not invoked here — that runs at module load in
 * production and is exercised by a separate manual smoke check.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the codex resolver registration so importing this module doesn't
// pollute the real codex provider's resolver chain.
vi.mock('./providers/codex.js', () => ({
  registerCodexAuthResolver: vi.fn(),
}));

// Stub readEnvFile so initializeClassAuth at import time sees no key
// (and therefore writes no file, doesn't disturb data/ on disk).
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import { getAgentGroup } from './db/agent-groups.js';
import { classCodexAuthResolver } from './class-codex-auth.js';
import { DATA_DIR } from './config.js';

const CLASS_AUTH_PATH = path.join(DATA_DIR, 'class-codex-auth.json');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Always clean up — never leave a stub auth.json on disk.
  if (fs.existsSync(CLASS_AUTH_PATH)) fs.rmSync(CLASS_AUTH_PATH);
});

function stubAgentGroup(id: string, folder: string) {
  (getAgentGroup as ReturnType<typeof vi.fn>).mockImplementation((askedId: string) =>
    askedId === id ? { id, name: id, folder, agent_provider: 'codex', created_at: '' } : undefined,
  );
}

describe('classCodexAuthResolver', () => {
  it('returns the class auth path for a student_NN folder when the file exists', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLASS_AUTH_PATH, '{"auth_mode":"apikey"}');
    stubAgentGroup('ag_student_42', 'student_42');

    const r = classCodexAuthResolver({ agentGroupId: 'ag_student_42', hostHome: '/home/test' });
    expect(r).toEqual({ name: 'class-pool', path: CLASS_AUTH_PATH });
  });

  it('returns the class auth path for ta_ and instructor_ prefixes too', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLASS_AUTH_PATH, '{"auth_mode":"apikey"}');

    stubAgentGroup('ag_ta_1', 'ta_1');
    expect(classCodexAuthResolver({ agentGroupId: 'ag_ta_1', hostHome: '/home/test' })).not.toBeNull();

    stubAgentGroup('ag_instructor_main', 'instructor_main');
    expect(classCodexAuthResolver({ agentGroupId: 'ag_instructor_main', hostHome: '/home/test' })).not.toBeNull();
  });

  it('returns null for non-class agent groups (no folder prefix match)', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLASS_AUTH_PATH, '{"auth_mode":"apikey"}');
    stubAgentGroup('ag_telegram_main', 'telegram_main');

    expect(classCodexAuthResolver({ agentGroupId: 'ag_telegram_main', hostHome: '/home/test' })).toBeNull();
  });

  it('returns null when the class auth.json file is missing', () => {
    // Ensure the file does NOT exist.
    if (fs.existsSync(CLASS_AUTH_PATH)) fs.rmSync(CLASS_AUTH_PATH);
    stubAgentGroup('ag_student_42', 'student_42');

    expect(classCodexAuthResolver({ agentGroupId: 'ag_student_42', hostHome: '/home/test' })).toBeNull();
  });

  it('returns null when the agent group does not exist in the DB', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLASS_AUTH_PATH, '{"auth_mode":"apikey"}');
    (getAgentGroup as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    expect(classCodexAuthResolver({ agentGroupId: 'ag_ghost', hostHome: '/home/test' })).toBeNull();
  });
});
