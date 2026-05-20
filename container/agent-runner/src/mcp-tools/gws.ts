/**
 * Google Workspace MCP tools (Phase 13).
 *
 * Forwards calls to the host-side relay (`src/gws-mcp-relay.ts`,
 * default port 3007) rather than hitting googleapis.com directly. The
 * relay authenticates the caller via the `X-NanoClaw-Agent-Group`
 * header, applies role-based scoping (`canAccessAgentGroup`), and
 * resolves a per-student OAuth bearer via
 * `getGoogleAccessTokenForAgentGroup`. Everything Google-specific
 * stays on the host.
 *
 * V1 surface (mirrors `src/gws-mcp-server.ts`):
 *   drive_doc_read_as_markdown    — export a Doc to markdown
 *   drive_doc_write_from_markdown — overwrite (or create) a Doc from markdown
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

// ── Gmail MCP tool definitions (Phase 14 Tier C) ──────────────────────────

/** Friendly guidance rendered when the student hasn't connected Google. */
function connectRequired(): ReturnType<typeof ok> {
  return ok("Your Google account isn't connected yet. Open the playground home tab and click \"Connect Google\", then try again.");
}

export const gmailSearch: McpToolDefinition = {
  tool: {
    name: 'gmail_search',
    description:
      'Search the student\'s Gmail inbox. Pass a Gmail search query (e.g. "from:someone@example.com", "subject:invoice", "is:unread"). Returns message summaries including id, threadId, snippet, subject, from, and date. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Gmail search query string (same syntax as the Gmail search bar).' },
        max_results: {
          type: 'number',
          description: 'Maximum messages to return (default 20, capped at 50).',
        },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const result = await callRelay('gmail_search', args as Record<string, unknown>);
    if (!result.ok) return err(result.error);
    const body = result.body as { ok: boolean; error?: string; reason?: string; messages?: unknown[] };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'gmail_search failed');
    }
    return ok(JSON.stringify(body.messages, null, 2));
  },
};

export const gmailReadThread: McpToolDefinition = {
  tool: {
    name: 'gmail_read_thread',
    description:
      'Read a full Gmail thread by its thread ID. Returns all messages in the thread with from/to/cc/subject/date headers and decoded body text. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID (from gmail_search results or a message threadId).' },
      },
      required: ['thread_id'],
    },
  },
  async handler(args) {
    const threadId = args.thread_id as string;
    if (!threadId) return err('thread_id is required');
    const result = await callRelay('gmail_read_thread', { thread_id: threadId });
    if (!result.ok) return err(result.error);
    const body = result.body as { ok: boolean; error?: string; reason?: string; messages?: unknown[]; threadId?: string };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'gmail_read_thread failed');
    }
    return ok(JSON.stringify({ threadId: body.threadId, messages: body.messages }, null, 2));
  },
};

export const gmailSendDraft: McpToolDefinition = {
  tool: {
    name: 'gmail_send_draft',
    description:
      'Create a Gmail DRAFT (never auto-sends). Returns the draftId and a composeUrl deep link so the student can review and send the draft manually from Gmail. To reply within a thread, pass in_reply_to_thread_id. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          description: 'Recipient address(es) — a single string or an array of strings.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
        cc: {
          description: 'CC address(es) — a single string or an array of strings (optional).',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        in_reply_to_thread_id: {
          type: 'string',
          description: 'Thread ID to reply within. When set, the draft is placed in that thread.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  async handler(args) {
    const result = await callRelay('gmail_send_draft', args as Record<string, unknown>);
    if (!result.ok) return err(result.error);
    const body = result.body as {
      ok: boolean;
      error?: string;
      reason?: string;
      draftId?: string;
      messageId?: string;
      threadId?: string;
      composeUrl?: string;
    };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'gmail_send_draft failed');
    }
    return ok(JSON.stringify({ draftId: body.draftId, messageId: body.messageId, threadId: body.threadId, composeUrl: body.composeUrl }, null, 2));
  },
};

// ── Calendar MCP tool definitions (Phase 14 Tier D) ──────────────────────────

export const calendarListEvents: McpToolDefinition = {
  tool: {
    name: 'calendar_list_events',
    description:
      'List events on the student\'s primary Google Calendar between two timestamps. Returns id, summary, start, end, location, attendees, and htmlLink for each event. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_min: { type: 'string', description: 'Start of window (ISO-8601, e.g. "2026-05-20T00:00:00Z").' },
        time_max: { type: 'string', description: 'End of window (ISO-8601, e.g. "2026-05-21T00:00:00Z").' },
        max_results: { type: 'number', description: 'Maximum events to return (default 50, capped at 250).' },
      },
      required: ['time_min', 'time_max'],
    },
  },
  async handler(args) {
    const result = await callRelay('calendar_list_events', args as Record<string, unknown>);
    if (!result.ok) return err(result.error);
    const body = result.body as { ok: boolean; error?: string; reason?: string; events?: unknown[] };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'calendar_list_events failed');
    }
    return ok(JSON.stringify(body.events, null, 2));
  },
};

export const calendarCreateEvent: McpToolDefinition = {
  tool: {
    name: 'calendar_create_event',
    description:
      'Create an event on the student\'s primary Google Calendar. Returns the event ID and a link to the event in Google Calendar. Date-only start/end (e.g. "2026-05-20") or midnight-UTC timestamps create all-day events. Invites attendees and sends them notifications. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start: { type: 'string', description: 'Event start (ISO-8601). Date-only or midnight-Z for all-day.' },
        end: { type: 'string', description: 'Event end (ISO-8601). Date-only or midnight-Z for all-day.' },
        summary: { type: 'string', description: 'Event title.' },
        description: { type: 'string', description: 'Optional event description / notes.' },
        location: { type: 'string', description: 'Optional location string.' },
        attendees: {
          type: 'array',
          description: 'Optional list of attendees — either email strings or objects with an `email` field.',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
            ],
          },
        },
      },
      required: ['start', 'end', 'summary'],
    },
  },
  async handler(args) {
    const result = await callRelay('calendar_create_event', args as Record<string, unknown>);
    if (!result.ok) return err(result.error);
    const body = result.body as { ok: boolean; error?: string; reason?: string; eventId?: string; htmlLink?: string };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'calendar_create_event failed');
    }
    return ok(JSON.stringify({ eventId: body.eventId, htmlLink: body.htmlLink }, null, 2));
  },
};

export const calendarFindFreeSlot: McpToolDefinition = {
  tool: {
    name: 'calendar_find_free_slot',
    description:
      'Suggest free time slots within a calendar window. Lists events in the window and surfaces gaps at least `duration_minutes` long. Skips events marked as free (transparency=transparent). All-day events block the entire day. Requires the student to have connected their Google account.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        duration_minutes: { type: 'number', description: 'Minimum slot length in minutes (e.g. 30, 60).' },
        time_min: { type: 'string', description: 'Start of search window (ISO-8601).' },
        time_max: { type: 'string', description: 'End of search window (ISO-8601).' },
        max_slots: { type: 'number', description: 'Maximum slots to return (default 5).' },
      },
      required: ['duration_minutes', 'time_min', 'time_max'],
    },
  },
  async handler(args) {
    const result = await callRelay('calendar_find_free_slot', args as Record<string, unknown>);
    if (!result.ok) return err(result.error);
    const body = result.body as { ok: boolean; error?: string; reason?: string; slots?: unknown[] };
    if (!body.ok) {
      if (body.reason === 'connect_required') return connectRequired();
      return err(body.error || 'calendar_find_free_slot failed');
    }
    return ok(JSON.stringify(body.slots, null, 2));
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
  gmailSearch,
  gmailReadThread,
  gmailSendDraft,
  calendarListEvents,
  calendarCreateEvent,
  calendarFindFreeSlot,
]);
