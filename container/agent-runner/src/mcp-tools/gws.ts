/**
 * Google Workspace MCP tools (Phase 13).
 *
 * Forwards calls to the host-side relay (`src/gws-mcp-relay.ts`,
 * default port 3007) rather than hitting googleapis.com directly.
 * The relay resolves the caller's agent group from the per-container token
 * (X_NANOCLAW_AGENT_TOKEN) and applies canAccessAgentGroup before dispatch,
 * then resolves an OAuth bearer via `getGoogleAccessTokenForAgentGroup` —
 * always the calling group's OWN token, never another group's. A group
 * with no personal Google credentials gets a clear error, not silent
 * access to someone else's Drive. Everything Google-specific stays on
 * the host.
 *
 * Drive/Sheets/Docs/Slides only — no Gmail or Calendar tool exists here.
 * Mirrors `src/gws-mcp-server.ts`.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

export interface RelayCallResult {
  ok: true;
  body: unknown;
}
export interface RelayCallError {
  ok: false;
  error: string;
}

// Exported so extension modules (e.g., mcp-tools/gws-ownership.ts in the
// classroom branch) can reuse the same relay client.
export async function callRelay(
  toolName: string,
  args: Record<string, unknown>,
): Promise<RelayCallResult | RelayCallError> {
  const relayUrl = process.env.GWS_MCP_RELAY_URL;
  const agentGroupId = process.env.X_NANOCLAW_AGENT_GROUP;
  const agentToken = process.env.X_NANOCLAW_AGENT_TOKEN;
  if (!relayUrl) {
    return { ok: false, error: 'GWS_MCP_RELAY_URL not set — running outside a NanoClaw container?' };
  }
  if (!agentGroupId) {
    return { ok: false, error: 'X_NANOCLAW_AGENT_GROUP not set — relay would reject the call.' };
  }
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/tools/${toolName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nanoclaw-agent-group': agentGroupId,
        'x-nanoclaw-agent-token': agentToken ?? '',
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    return { ok: false, error: `GWS relay unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `GWS relay returned non-JSON (${res.status}): ${e instanceof Error ? e.message : String(e)}` };
  }
  // Relay echoes `{ ok, ... }` for both success and tool-error paths;
  // status code mirrors `ok`. Either signal is sufficient to branch.
  if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false) {
    const message = (body as { error?: unknown }).error;
    return { ok: false, error: typeof message === 'string' ? message : `GWS relay error (status ${res.status})` };
  }
  if (!res.ok) {
    return { ok: false, error: `GWS relay HTTP ${res.status}` };
  }
  return { ok: true, body };
}

export const driveDocReadAsMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_read_as_markdown',
    description:
      'Read a Google Doc and return its contents as markdown. Use this when you need to read or analyze the text of a Google Doc — rclone gives you a .gdoc pointer, this gives you the actual content. Pass the Doc file ID (the part after /document/d/ in the URL).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID of the Google Doc.' },
      },
      required: ['file_id'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    if (!fileId) return err('file_id is required');
    const r = await callRelay('drive_doc_read_as_markdown', { file_id: fileId });
    if (!r.ok) return err(r.error);
    const markdown = (r.body as { markdown?: unknown }).markdown;
    if (typeof markdown !== 'string') return err('GWS relay response missing `markdown` field.');
    return ok(markdown);
  },
};

export const driveDocWriteFromMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_write_from_markdown',
    description:
      'Overwrite an existing Google Doc with new markdown content. Pass `file_id` of the target Doc and the `markdown` body. To create a new Doc when the file_id does not exist yet, set `create_if_missing: true` and provide `parent_folder_id` + `name`. Returns the resulting Doc\'s file ID and whether it was newly created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID of the Google Doc to overwrite (or create at, with create_if_missing).' },
        markdown: { type: 'string', description: 'Markdown body to upload as the Doc\'s new content.' },
        create_if_missing: { type: 'boolean', description: 'When true and the file_id 404s, create a new Doc instead.' },
        parent_folder_id: { type: 'string', description: 'Drive folder ID to place the new Doc in (used only on create).' },
        name: { type: 'string', description: 'Title for the new Doc (used only on create).' },
      },
      required: ['file_id', 'markdown'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    const markdown = args.markdown as string;
    if (!fileId) return err('file_id is required');
    if (typeof markdown !== 'string') return err('markdown is required');
    const payload: Record<string, unknown> = { file_id: fileId, markdown };
    if (typeof args.create_if_missing === 'boolean') payload.create_if_missing = args.create_if_missing;
    if (typeof args.parent_folder_id === 'string') payload.parent_folder_id = args.parent_folder_id;
    if (typeof args.name === 'string') payload.name = args.name;
    const r = await callRelay('drive_doc_write_from_markdown', payload);
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const sheetReadRange: McpToolDefinition = {
  tool: {
    name: 'sheet_read_range',
    description:
      'Read a range from a Google Sheet. Pass the spreadsheet_id (the part after /spreadsheets/d/ in the URL) and the range in A1 notation (e.g. "Sheet1!A1:C10" or "A1:C10" to use the first sheet). Returns values as a 2D string array.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'Drive file ID of the Google Sheet.' },
        range: {
          type: 'string',
          description: 'A1-notation range. Prepend "<SheetName>!" to target a specific tab.',
        },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  async handler(args) {
    const spreadsheetId = args.spreadsheet_id as string;
    const range = args.range as string;
    if (!spreadsheetId) return err('spreadsheet_id is required');
    if (!range) return err('range is required');
    const r = await callRelay('sheet_read_range', { spreadsheet_id: spreadsheetId, range });
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const sheetWriteRange: McpToolDefinition = {
  tool: {
    name: 'sheet_write_range',
    description:
      'Write a 2D string array into a Google Sheet range using A1 notation. Defaults to `value_input_option: "USER_ENTERED"` so formulas starting with `=` evaluate; pass `"RAW"` to store as literal text. In Mode A (shared class workspace) writes are gated by the nanoclaw_owners tag — first writer claims the spreadsheet; subsequent writers must be in the owners list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'Drive file ID of the Google Sheet to write to.' },
        range: { type: 'string', description: 'A1-notation range, e.g. "Sheet1!A1:C3".' },
        values: {
          type: 'array',
          description: '2D array of cell values: rows of columns. Stringify numbers/dates yourself.',
          items: { type: 'array', items: { type: 'string' } },
        },
        value_input_option: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How input is interpreted. USER_ENTERED (default) evaluates formulas; RAW stores literally.',
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  async handler(args) {
    const spreadsheetId = args.spreadsheet_id as string;
    const range = args.range as string;
    const values = args.values as unknown;
    if (!spreadsheetId) return err('spreadsheet_id is required');
    if (!range) return err('range is required');
    if (!Array.isArray(values)) return err('values must be a 2D array');
    const payload: Record<string, unknown> = { spreadsheet_id: spreadsheetId, range, values };
    if (typeof args.value_input_option === 'string') payload.value_input_option = args.value_input_option;
    const r = await callRelay('sheet_write_range', payload);
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const slidesCreateDeck: McpToolDefinition = {
  tool: {
    name: 'slides_create_deck',
    description:
      'Create a new Google Slides presentation. Optional `title` (defaults to "Untitled") and `parent_folder_id` (drops the deck into a specific Drive folder, otherwise lands in the user\'s root). In Mode A the new deck is auto-stamped with the caller as owner + shared anyone-with-link.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Display title for the new deck.' },
        parent_folder_id: { type: 'string', description: 'Drive folder ID to place the new deck in.' },
      },
    },
  },
  async handler(args) {
    const payload: Record<string, unknown> = {};
    if (typeof args.title === 'string') payload.title = args.title;
    if (typeof args.parent_folder_id === 'string') payload.parent_folder_id = args.parent_folder_id;
    const r = await callRelay('slides_create_deck', payload);
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const slidesAppendSlide: McpToolDefinition = {
  tool: {
    name: 'slides_append_slide',
    description:
      'Append a new slide at the end of an existing Google Slides deck. Optional `layout` (e.g. BLANK, TITLE, TITLE_AND_BODY, SECTION_HEADER) — defaults to BLANK. Returns the new slide\'s object ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string', description: 'Drive file ID of the target Slides deck.' },
        layout: {
          type: 'string',
          description:
            'Slides predefined layout name. Common values: BLANK, TITLE, TITLE_AND_BODY, SECTION_HEADER, ONE_COLUMN_TEXT, MAIN_POINT, BIG_NUMBER, TITLE_AND_TWO_COLUMNS.',
        },
      },
      required: ['presentation_id'],
    },
  },
  async handler(args) {
    const presentationId = args.presentation_id as string;
    if (!presentationId) return err('presentation_id is required');
    const payload: Record<string, unknown> = { presentation_id: presentationId };
    if (typeof args.layout === 'string') payload.layout = args.layout;
    const r = await callRelay('slides_append_slide', payload);
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const slidesReplaceText: McpToolDefinition = {
  tool: {
    name: 'slides_replace_text',
    description:
      'Find-and-replace text across every slide in a Google Slides deck. Case-sensitive. Returns the count of occurrences changed (0 is success, not an error). Useful for templating decks (e.g. replace `{{name}}` with `Sam`).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string', description: 'Drive file ID of the target Slides deck.' },
        find: { type: 'string', description: 'Exact text to search for (case-sensitive).' },
        replace_with: { type: 'string', description: 'Text to insert in place of every match.' },
      },
      required: ['presentation_id', 'find', 'replace_with'],
    },
  },
  async handler(args) {
    const presentationId = args.presentation_id as string;
    const find = args.find as string;
    const replaceWith = args.replace_with as string;
    if (!presentationId) return err('presentation_id is required');
    if (!find) return err('find is required');
    if (typeof replaceWith !== 'string') return err('replace_with is required');
    const r = await callRelay('slides_replace_text', {
      presentation_id: presentationId,
      find,
      replace_with: replaceWith,
    });
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

registerTools([
  driveDocReadAsMarkdown,
  driveDocWriteFromMarkdown,
  sheetReadRange,
  sheetWriteRange,
  slidesCreateDeck,
  slidesAppendSlide,
  slidesReplaceText,
]);
