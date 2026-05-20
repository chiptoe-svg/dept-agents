/**
 * Server / dispatch unit tests. Stubs the tool handlers so this suite
 * never hits @googleapis. Validation paths covered here; the actual
 * Drive API interaction lives in gws-mcp-tools.test.ts (mocked there).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gws-mcp-tools.js', () => ({
  driveDocReadAsMarkdown: vi.fn(async (_ctx, args: { file_id: string }) => ({
    ok: true,
    fileId: args.file_id,
    markdown: '# stub\n',
    bytes: 8,
  })),
  driveDocWriteFromMarkdown: vi.fn(async (_ctx, args: { file_id: string }) => ({
    ok: true,
    fileId: args.file_id,
    bytes: 0,
    created: false,
  })),
  sheetReadRange: vi.fn(async (_ctx, args: { spreadsheet_id: string; range: string }) => ({
    ok: true,
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
    values: [['a', 'b']],
    cells: 2,
  })),
  sheetWriteRange: vi.fn(async (_ctx, args: { spreadsheet_id: string; range: string }) => ({
    ok: true,
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
    updatedCells: 4,
  })),
  slidesCreateDeck: vi.fn(async (_ctx, args: { title?: string }) => ({
    ok: true,
    presentationId: 'pres_new',
    webViewLink: `https://docs.google.com/presentation/d/pres_new`,
    _title: args.title,
  })),
  slidesAppendSlide: vi.fn(async (_ctx, args: { presentation_id: string }) => ({
    ok: true,
    presentationId: args.presentation_id,
    slideId: 'slide_xyz',
  })),
  slidesReplaceText: vi.fn(async (_ctx, args: { presentation_id: string }) => ({
    ok: true,
    presentationId: args.presentation_id,
    occurrencesChanged: 3,
  })),
  // Gmail tools (Phase 14 Tier C)
  gmailSearch: vi.fn(async () => ({ ok: true, threads: [], principal: 'instructor' })),
  gmailReadThread: vi.fn(async () => ({ ok: true, threadId: 'stub', messages: [], principal: 'instructor' })),
  gmailSendDraft: vi.fn(async () => ({
    ok: true,
    draftId: 'd_stub',
    composeUrl: 'https://mail.google.com/',
    principal: 'instructor',
  })),
  // Calendar tools (Phase 14 Tier D)
  calendarListEvents: vi.fn(async () => ({ ok: true, events: [], principal: 'instructor' })),
  calendarCreateEvent: vi.fn(async () => ({
    ok: true,
    eventId: 'e_stub',
    htmlLink: 'https://calendar.google.com/',
    principal: 'instructor',
  })),
  calendarFindFreeSlot: vi.fn(async () => ({ ok: true, slots: [], principal: 'instructor' })),
  // Hook registration / token resolver (passthrough no-ops)
  registerPreMutationHook: vi.fn(),
  registerPostCreateHook: vi.fn(),
  _resetHooksForTest: vi.fn(),
  resolveTokenOrError: vi.fn(async () => ({ ok: true, token: 'stub-token', principal: 'instructor' })),
  buildDriveClient: vi.fn(),
}));

import { dispatchTool, listToolNames } from './gws-mcp-server.js';

afterEach(() => vi.clearAllMocks());

describe('listToolNames', () => {
  it('returns the V1 + V2 base tool names (ext-installed names register elsewhere)', () => {
    expect(new Set(listToolNames())).toEqual(
      new Set([
        'drive_doc_read_as_markdown',
        'drive_doc_write_from_markdown',
        'sheet_read_range',
        'sheet_write_range',
        'slides_create_deck',
        'slides_append_slide',
        'slides_replace_text',
        'gmail_search',
        'gmail_read_thread',
        'gmail_send_draft',
        'calendar_list_events',
        'calendar_create_event',
        'calendar_find_free_slot',
      ]),
    );
  });
});

describe('dispatchTool', () => {
  it('returns 404 for unknown tool', async () => {
    const r = await dispatchTool({ ctx: { agentGroupId: 'ag_x' }, toolName: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(404);
  });

  it('returns 400 when args are not an object', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_read_as_markdown',
      args: 'oops',
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
  });

  it('returns 400 when read is missing file_id', async () => {
    const r = await dispatchTool({ ctx: { agentGroupId: 'ag_x' }, toolName: 'drive_doc_read_as_markdown', args: {} });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
    expect((r as unknown as { error: string }).error).toContain('file_id');
  });

  it('returns 400 when write is missing markdown', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_write_from_markdown',
      args: { file_id: 'abc' },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
    expect((r as unknown as { error: string }).error).toContain('markdown');
  });

  it('dispatches to the read handler with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_read_as_markdown',
      args: { file_id: 'doc_abc' },
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { fileId: string }).fileId).toBe('doc_abc');
  });

  it('dispatches to the write handler with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_write_from_markdown',
      args: { file_id: 'doc_abc', markdown: '# hi' },
    });
    expect(r.ok).toBe(true);
  });

  it('catches handler exceptions and returns 500', async () => {
    const tools = await import('./gws-mcp-tools.js');
    (tools.driveDocReadAsMarkdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_read_as_markdown',
      args: { file_id: 'doc_abc' },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(500);
    expect((r as unknown as { error: string }).error).toContain('boom');
  });

  it('returns 400 when sheet_read_range is missing range', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'sheet_read_range',
      args: { spreadsheet_id: 'sht_abc' },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
    expect((r as unknown as { error: string }).error).toContain('range');
  });

  it('returns 400 when sheet_write_range values is not a 2D array', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'sheet_write_range',
      args: { spreadsheet_id: 'sht_abc', range: 'A1', values: ['a', 'b'] },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
    expect((r as unknown as { error: string }).error).toContain('2D');
  });

  it('returns 400 when sheet_write_range has an invalid value_input_option', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'sheet_write_range',
      args: { spreadsheet_id: 'sht_abc', range: 'A1', values: [['a']], value_input_option: 'BOGUS' },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
  });

  it('dispatches to sheet_read_range with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'sheet_read_range',
      args: { spreadsheet_id: 'sht_abc', range: 'Sheet1!A1:B2' },
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { spreadsheetId: string }).spreadsheetId).toBe('sht_abc');
  });

  it('dispatches to sheet_write_range with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'sheet_write_range',
      args: {
        spreadsheet_id: 'sht_abc',
        range: 'A1:B2',
        values: [
          ['x', 'y'],
          ['z', 'w'],
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { updatedCells: number }).updatedCells).toBe(4);
  });

  it('dispatches to slides_create_deck with no required args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'slides_create_deck',
      args: {},
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { presentationId: string }).presentationId).toBe('pres_new');
  });

  it('returns 400 when slides_append_slide is missing presentation_id', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'slides_append_slide',
      args: {},
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
  });

  it('dispatches to slides_append_slide with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'slides_append_slide',
      args: { presentation_id: 'pres_abc', layout: 'TITLE_AND_BODY' },
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { slideId: string }).slideId).toBe('slide_xyz');
  });

  it('returns 400 when slides_replace_text is missing find', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'slides_replace_text',
      args: { presentation_id: 'pres_abc', replace_with: 'hi' },
    });
    expect(r.ok).toBe(false);
    expect((r as unknown as { status?: number }).status).toBe(400);
    expect((r as unknown as { error: string }).error).toContain('find');
  });

  it('dispatches to slides_replace_text and returns the occurrences count', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'slides_replace_text',
      args: { presentation_id: 'pres_abc', find: '{{name}}', replace_with: 'Sam' },
    });
    expect(r.ok).toBe(true);
    expect((r as unknown as { occurrencesChanged: number }).occurrencesChanged).toBe(3);
  });
});
