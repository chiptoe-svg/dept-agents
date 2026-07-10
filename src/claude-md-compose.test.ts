import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock config so GROUPS_DIR points to our temp dir.
let mockGroupsDir: string;
vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return mockGroupsDir;
  },
}));

// Mock materializeContainerJson — returns no MCP servers by default (no
// inline `instructions` fragments, no DB/filesystem side effects).
const mockMaterializeContainerJson = vi.fn<(id: string) => { mcpServers: Record<string, unknown> }>();
vi.mock('./container-config.js', () => ({
  materializeContainerJson: (...args: unknown[]) => mockMaterializeContainerJson(args[0] as string),
}));

import {
  composeGroupClaudeMd,
  evaluatePersonaSize,
  PERSONA_HARD_MAX_BYTES,
  PERSONA_WARN_BYTES,
} from './claude-md-compose.js';
import { log } from './log.js';

// --- Helpers ---

function makeGroup(id = 'g1', folder = 'test-group') {
  return {
    id,
    folder,
    name: 'Test Group',
    created_at: new Date().toISOString(),
  } as unknown as import('./types.js').AgentGroup;
}

// --- Tests ---

describe('evaluatePersonaSize', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing for a healthy persona size', () => {
    expect(() => evaluatePersonaSize(30 * 1024, { group: 'g', memoryFile: 'CLAUDE.local.md' })).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns (without throwing) in the warn band', () => {
    expect(() =>
      evaluatePersonaSize(PERSONA_WARN_BYTES + 1024, { group: 'g', memoryFile: 'CLAUDE.local.md' }),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith('Composed persona is large', expect.objectContaining({ group: 'g' }));
  });

  it('throws (fail-loud) above the hard cap, naming the actual size, the limit, and the likely cause', () => {
    const resolvedBytes = PERSONA_HARD_MAX_BYTES + 1024;
    let thrown: Error | undefined;
    try {
      evaluatePersonaSize(resolvedBytes, { group: 'pi-test', memoryFile: 'CLAUDE.local.md' });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Actual resolved size, in KB, is in the message.
    expect(thrown!.message).toContain(`${(resolvedBytes / 1024).toFixed(1)} KB`);
    // The hard cap (the limit) is in the message.
    expect(thrown!.message).toContain(`${PERSONA_HARD_MAX_BYTES / 1024} KB hard cap`);
    // Names the likely cause / memory file, not just a generic error.
    expect(thrown!.message).toContain('CLAUDE.local.md');
    expect(thrown!.message).toContain('pi-test');
  });

  it('does not silently truncate — it throws instead of returning a clamped value', () => {
    // evaluatePersonaSize is `void`-returning: there is no "clamped size" to
    // observe, which is itself the point. Assert the throw is the only
    // signal — no return value is produced on the failure path.
    expect(() =>
      evaluatePersonaSize(PERSONA_HARD_MAX_BYTES + 1, { group: 'g', memoryFile: 'CLAUDE.local.md' }),
    ).toThrow();
  });
});

describe('composeGroupClaudeMd', () => {
  let workDir: string;
  let projectRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'claude-md-compose-test-'));
    mockGroupsDir = path.join(workDir, 'groups');
    mkdirSync(mockGroupsDir, { recursive: true });

    // Fake project root with a minimal container/CLAUDE.md — composeGroupClaudeMd
    // reads process.cwd() to find the shared base + skills/mcp-tools dirs.
    projectRoot = path.join(workDir, 'project');
    mkdirSync(path.join(projectRoot, 'container'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'container', 'CLAUDE.md'), 'shared base content\n');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);

    mockMaterializeContainerJson.mockReturnValue({ mcpServers: {} });
    vi.clearAllMocks();
    mockMaterializeContainerJson.mockReturnValue({ mcpServers: {} });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes composed content to CLAUDE.md', () => {
    const group = makeGroup();
    composeGroupClaudeMd(group);

    const outputPath = path.join(mockGroupsDir, group.folder, 'CLAUDE.md');
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, 'utf8');
    expect(content).toContain('<!-- Composed at spawn');
    expect(content).toContain('@./.claude-shared.md');
  });

  it('creates group directory if missing', () => {
    const group = makeGroup('g3', 'new-group');
    const groupDir = path.join(mockGroupsDir, group.folder);
    expect(existsSync(groupDir)).toBe(false);

    composeGroupClaudeMd(group);

    expect(existsSync(groupDir)).toBe(true);
    expect(existsSync(path.join(groupDir, 'CLAUDE.md'))).toBe(true);
  });

  it('creates empty CLAUDE.local.md if missing', () => {
    const group = makeGroup();
    composeGroupClaudeMd(group);

    const localMd = path.join(mockGroupsDir, group.folder, 'CLAUDE.local.md');
    expect(existsSync(localMd)).toBe(true);
  });

  it('preserves existing CLAUDE.local.md contents', () => {
    const group = makeGroup();
    const groupDir = path.join(mockGroupsDir, group.folder);
    mkdirSync(groupDir, { recursive: true });
    const localMd = path.join(groupDir, 'CLAUDE.local.md');
    const existingContent = 'My custom instructions\n';
    writeFileSync(localMd, existingContent);

    composeGroupClaudeMd(group);

    expect(readFileSync(localMd, 'utf8')).toBe(existingContent);
  });

  it('output is deterministic across repeated calls', () => {
    const group = makeGroup();
    composeGroupClaudeMd(group);
    const outputPath = path.join(mockGroupsDir, group.folder, 'CLAUDE.md');
    const first = readFileSync(outputPath, 'utf8');

    composeGroupClaudeMd(group);
    const second = readFileSync(outputPath, 'utf8');

    expect(first).toBe(second);
  });

  it('throws — and does not write a new CLAUDE.md — when CLAUDE.local.md alone blows the persona budget', () => {
    const group = makeGroup('g4', 'bloated-group');
    const groupDir = path.join(mockGroupsDir, group.folder);
    mkdirSync(groupDir, { recursive: true });
    // Oversized memory file — bigger than the hard cap on its own.
    writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'x'.repeat(PERSONA_HARD_MAX_BYTES + 1024));

    expect(() => composeGroupClaudeMd(group)).toThrow(/hard cap/);
    expect(() => composeGroupClaudeMd(group)).toThrow(/CLAUDE\.local\.md/);

    // Fail-loud, not silent truncation: no new CLAUDE.md is written when
    // the guard trips (the pre-existing state is left alone).
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('sums fragment file sizes (not just the manifest) when evaluating the budget', () => {
    // A single inline MCP `instructions` fragment larger than the hard cap
    // must trip the guard even though CLAUDE.md itself stays tiny.
    mockMaterializeContainerJson.mockReturnValue({
      mcpServers: {
        big: { instructions: 'y'.repeat(PERSONA_HARD_MAX_BYTES + 1024) },
      },
    });
    const group = makeGroup('g5', 'big-mcp-group');

    expect(() => composeGroupClaudeMd(group)).toThrow(/hard cap/);
  });
});
