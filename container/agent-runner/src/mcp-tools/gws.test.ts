/**
 * Unit tests for the container-side Google Workspace MCP tools.
 * Verifies the tool handlers translate args → relay HTTP POST, and the
 * relay's `{ ok, ... }` envelope into MCP `content` / `isError` shape.
 *
 * Bun runtime — `bun:test`. We mock `globalThis.fetch` directly so the
 * tests don't need a running relay.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  driveDocReadAsMarkdown,
  driveDocWriteFromMarkdown,
  sheetReadRange,
  sheetWriteRange,
  slidesAppendSlide,
  slidesCreateDeck,
  slidesReplaceText,
} from './gws.js';

const RELAY_URL = 'http://host.docker.internal:3007';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(response: { status: number; body: unknown }): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe('gws.ts → relay HTTP shape', () => {
  let savedRelay: string | undefined;
  let savedAgent: string | undefined;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    savedRelay = process.env.GWS_MCP_RELAY_URL;
    savedAgent = process.env.X_NANOCLAW_AGENT_GROUP;
    process.env.GWS_MCP_RELAY_URL = RELAY_URL;
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
  });

  afterEach(() => {
    if (restore) restore();
    restore = null;
    if (savedRelay === undefined) delete process.env.GWS_MCP_RELAY_URL;
    else process.env.GWS_MCP_RELAY_URL = savedRelay;
    if (savedAgent === undefined) delete process.env.X_NANOCLAW_AGENT_GROUP;
    else process.env.X_NANOCLAW_AGENT_GROUP = savedAgent;
  });

  test('drive_doc_read_as_markdown POSTs to the right path with attribution header', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, fileId: 'f1', markdown: '# Hi', bytes: 4 },
    });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'f1' });

    expect(cap.calls).toHaveLength(1);
    const call = cap.calls[0]!;
    expect(call.url).toBe(`${RELAY_URL}/tools/drive_doc_read_as_markdown`);
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers as HeadersInit | undefined);
    expect(headers.get('x-nanoclaw-agent-group')).toBe('ag_test_42');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.init?.body as string)).toEqual({ file_id: 'f1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: '# Hi' });
  });

  test('drive_doc_read_as_markdown surfaces relay error body as MCP isError', async () => {
    const cap = captureFetch({
      status: 404,
      body: { ok: false, error: 'File not found', status: 404 },
    });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'gone' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('File not found');
  });

  test('drive_doc_write_from_markdown forwards optional create flags', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, fileId: 'f2', bytes: 5, created: true },
    });
    restore = cap.restore;

    const result = await driveDocWriteFromMarkdown.handler({
      file_id: 'f2',
      markdown: 'hello',
      create_if_missing: true,
      parent_folder_id: 'folder_xyz',
      name: 'My Doc',
    });

    const body = JSON.parse(cap.calls[0]!.init?.body as string);
    expect(body).toEqual({
      file_id: 'f2',
      markdown: 'hello',
      create_if_missing: true,
      parent_folder_id: 'folder_xyz',
      name: 'My Doc',
    });
    expect(result.isError).toBeUndefined();
  });

  test('returns MCP error when GWS_MCP_RELAY_URL unset (no fetch call)', async () => {
    delete process.env.GWS_MCP_RELAY_URL;
    const cap = captureFetch({ status: 200, body: { ok: true } });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'whatever' });

    expect(cap.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test('returns MCP error when X_NANOCLAW_AGENT_GROUP unset (no fetch call)', async () => {
    delete process.env.X_NANOCLAW_AGENT_GROUP;
    const cap = captureFetch({ status: 200, body: { ok: true } });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'whatever' });

    expect(cap.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test('hard-block error from drive_doc_write_from_markdown surfaces creator name', async () => {
    const cap = captureFetch({
      status: 403,
      body: {
        ok: false,
        error:
          'Blocked: this file is owned by Sam. Ask one of them to share write access via drive_doc_grant_ownership, or to make the change themselves.',
        status: 403,
      },
    });
    restore = cap.restore;

    const result = await driveDocWriteFromMarkdown.handler({ file_id: 'f1', markdown: '# nope' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Sam');
    expect(text).toContain('drive_doc_grant_ownership');
  });

  test('sheet_read_range forwards spreadsheet_id + range', async () => {
    const cap = captureFetch({
      status: 200,
      body: {
        ok: true,
        spreadsheetId: 'sht_abc',
        range: 'Sheet1!A1:B2',
        values: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        cells: 4,
      },
    });
    restore = cap.restore;

    const result = await sheetReadRange.handler({ spreadsheet_id: 'sht_abc', range: 'Sheet1!A1:B2' });

    expect(cap.calls[0]!.url).toBe(`${RELAY_URL}/tools/sheet_read_range`);
    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({
      spreadsheet_id: 'sht_abc',
      range: 'Sheet1!A1:B2',
    });
    expect(result.isError).toBeUndefined();
  });

  test('sheet_write_range forwards values + optional value_input_option', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, spreadsheetId: 'sht_abc', range: 'A1:B2', updatedCells: 4 },
    });
    restore = cap.restore;

    const result = await sheetWriteRange.handler({
      spreadsheet_id: 'sht_abc',
      range: 'A1:B2',
      values: [
        ['x', 'y'],
        ['z', 'w'],
      ],
      value_input_option: 'RAW',
    });

    const body = JSON.parse(cap.calls[0]!.init?.body as string);
    expect(body).toEqual({
      spreadsheet_id: 'sht_abc',
      range: 'A1:B2',
      values: [
        ['x', 'y'],
        ['z', 'w'],
      ],
      value_input_option: 'RAW',
    });
    expect(result.isError).toBeUndefined();
  });

  test('sheet_write_range surfaces Mode A hard-block from relay', async () => {
    const cap = captureFetch({
      status: 403,
      body: { ok: false, error: 'Blocked: this file is owned by Sam.', status: 403 },
    });
    restore = cap.restore;

    const result = await sheetWriteRange.handler({
      spreadsheet_id: 'sht_abc',
      range: 'A1:B2',
      values: [['x']],
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Sam');
  });

  test('sheet_write_range requires a 2D values array', async () => {
    const cap = captureFetch({ status: 200, body: { ok: true } });
    restore = cap.restore;

    const result = await sheetWriteRange.handler({
      spreadsheet_id: 'sht_abc',
      range: 'A1',
      values: 'not-an-array' as unknown as string[][],
    });

    expect(cap.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test('slides_create_deck forwards optional title + parent_folder_id', async () => {
    const cap = captureFetch({
      status: 200,
      body: {
        ok: true,
        presentationId: 'pres_new',
        webViewLink: 'https://docs.google.com/presentation/d/pres_new',
      },
    });
    restore = cap.restore;

    const result = await slidesCreateDeck.handler({
      title: 'My Deck',
      parent_folder_id: 'folder_xyz',
    });

    expect(cap.calls[0]!.url).toBe(`${RELAY_URL}/tools/slides_create_deck`);
    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({
      title: 'My Deck',
      parent_folder_id: 'folder_xyz',
    });
    expect(result.isError).toBeUndefined();
  });

  test('slides_create_deck works with no args (lands in root, default title)', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, presentationId: 'pres_new', webViewLink: null },
    });
    restore = cap.restore;

    const result = await slidesCreateDeck.handler({});

    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  test('slides_append_slide forwards presentation_id + layout', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, presentationId: 'pres_abc', slideId: 'slide_xyz' },
    });
    restore = cap.restore;

    const result = await slidesAppendSlide.handler({
      presentation_id: 'pres_abc',
      layout: 'TITLE_AND_BODY',
    });

    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({
      presentation_id: 'pres_abc',
      layout: 'TITLE_AND_BODY',
    });
    expect(result.isError).toBeUndefined();
  });

  test('slides_replace_text forwards find + replace_with and surfaces count', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, presentationId: 'pres_abc', occurrencesChanged: 5 },
    });
    restore = cap.restore;

    const result = await slidesReplaceText.handler({
      presentation_id: 'pres_abc',
      find: '{{name}}',
      replace_with: 'Sam',
    });

    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({
      presentation_id: 'pres_abc',
      find: '{{name}}',
      replace_with: 'Sam',
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"occurrencesChanged": 5');
  });

  test('slides_append_slide surfaces Mode A hard-block from relay', async () => {
    const cap = captureFetch({
      status: 403,
      body: { ok: false, error: 'Blocked: this file is owned by Sam.', status: 403 },
    });
    restore = cap.restore;

    const result = await slidesAppendSlide.handler({ presentation_id: 'pres_someone_elses' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Sam');
  });

});
