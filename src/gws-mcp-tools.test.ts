/**
 * Integration tests for gws-mcp-tools.ts.
 *
 * Tier B: principal field on Drive success results, and the fail-closed
 * token resolution shared by every Drive/Sheets/Slides tool (there is no
 * owner/instructor fallback — a group with no personal Google credentials
 * gets a clear "connect your Google account" error, never another
 * group's data).
 *
 * Strategy: mock ./gws-token.js so getGoogleAccessTokenForAgentGroup
 * returns a controlled { token, principal } without hitting disk or the
 * network; mock @googleapis/* so no real HTTP is made. Then invoke each
 * SUT function and assert the expected shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── hoisted mock state ────────────────────────────────────────────────────────

const { mockGetGoogleAccessTokenForAgentGroup, mockFilesExport } = vi.hoisted(() => ({
  mockGetGoogleAccessTokenForAgentGroup: vi.fn(),
  mockFilesExport: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./gws-token.js', () => ({
  getGoogleAccessTokenForAgentGroup: mockGetGoogleAccessTokenForAgentGroup,
}));

// Minimal @googleapis/drive stub — OAuth2 is shared across all googleapis
// clients; the real constructable class is needed so `new gAuth.OAuth2()` works.
vi.mock('@googleapis/drive', () => {
  class FakeOAuth2 {
    setCredentials(_creds: unknown) {}
  }
  return {
    drive: vi.fn(() => ({
      files: {
        export: mockFilesExport,
      },
    })),
    auth: { OAuth2: FakeOAuth2 },
  };
});

// @googleapis/sheets and @googleapis/slides are imported at module level but
// not called by the tools under test here — stub to avoid resolution errors.
vi.mock('@googleapis/sheets', () => ({
  sheets: vi.fn(() => ({ spreadsheets: { values: { get: vi.fn(), update: vi.fn() } } })),
}));

vi.mock('@googleapis/slides', () => ({
  slides: vi.fn(() => ({ presentations: { batchUpdate: vi.fn() } })),
}));

// ── import SUT after mocks ────────────────────────────────────────────────────

import { driveDocReadAsMarkdown, resolveTokenOrError } from './gws-mcp-tools.js';
import { listToolNames } from './gws-mcp-server.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = { agentGroupId: 'ag_test' };
const FAKE_MARKDOWN = '# Hello\n\nWorld';

/** Wire mockFilesExport to return a successful export response. */
function stubDriveExportOk() {
  mockFilesExport.mockResolvedValue({ data: FAKE_MARKDOWN });
}

// ── Tool registry: no Gmail/Calendar, fail-closed token resolution ─────────────

describe('tool registry — Gmail/Calendar removed', () => {
  it('contains no tool whose name starts with gmail_ or calendar_', () => {
    const names = listToolNames();
    const leaked = names.filter((n) => n.startsWith('gmail_') || n.startsWith('calendar_'));
    expect(leaked).toEqual([]);
  });
});

describe('resolveTokenOrError — every remaining tool fails closed without a personal token', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns a clear connect-required error (not the owner/instructor token) when resolution fails', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await resolveTokenOrError({ agentGroupId: 'ag_test' });

    expect('token' in result).toBe(false);
    if ('token' in result) return;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('connect_required');
    expect(result.error).toMatch(/connect your google account/i);
  });
});

// ── Tier B: Drive tests ───────────────────────────────────────────────────────

describe('driveDocReadAsMarkdown — principal field', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubDriveExportOk();
  });

  it('carries principal: "self" when resolver returns a per-student token', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'fake-student-token', principal: 'self' });

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_abc' });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TypeScript
    expect(result.principal).toBe('self');
    expect(result.fileId).toBe('doc_abc');
    expect(result.markdown).toBe(FAKE_MARKDOWN);
  });

  it('returns ok:false with connect_required (no owner fallback, no principal) when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_nope' });

    expect(result.ok).toBe(false);
    expect('principal' in result).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
  });
});
