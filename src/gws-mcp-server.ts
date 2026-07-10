/**
 * GWS MCP server — tool registry + dispatch.
 *
 * In-process function callable by `gws-mcp-relay.ts` after the relay
 * has read the per-call attribution header and confirmed the agent
 * group exists. Knows nothing about HTTP — pure dispatch.
 *
 * V1 surface (Phase 13.2):
 *   - `drive_doc_read_as_markdown`
 *   - `drive_doc_write_from_markdown`
 *
 * Adding a tool: define the handler in `gws-mcp-tools.ts`, add an
 * entry to `TOOL_REGISTRY` below. Argument validation is the tool
 * handler's responsibility (returns `ToolError` with status 400 on
 * malformed input).
 */
import {
  driveDocReadAsMarkdown,
  driveDocWriteFromMarkdown,
  sheetReadRange,
  sheetWriteRange,
  slidesCreateDeck,
  slidesAppendSlide,
  slidesReplaceText,
  type ToolContext,
  type ToolError,
  type DocReadResult,
  type DocWriteResult,
} from './gws-mcp-tools.js';

/**
 * Names of the built-in V1 tools. Extensions can register additional
 * tool names dynamically via `registerGwsTool`; the type system can't
 * enumerate those — callers treat dispatched tool names as `string`.
 */
export type ToolName =
  | 'drive_doc_read_as_markdown'
  | 'drive_doc_write_from_markdown'
  | 'sheet_read_range'
  | 'sheet_write_range'
  | 'slides_create_deck'
  | 'slides_append_slide'
  | 'slides_replace_text';

/**
 * Result shape returned by `dispatchTool`. The dispatcher forwards
 * whatever the handler returns and only inspects `.ok` for error
 * paths; we don't try to enumerate every extension's result shape.
 */
export type ToolResult = { ok: boolean } & Record<string, unknown>;

interface ToolEntry<A> {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: ToolContext, args: any) => Promise<unknown>;
  validate: (raw: unknown) => A | string;
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function asString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function validateRead(raw: unknown): { file_id: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  return { file_id: fileId };
}

function validateWrite(
  raw: unknown,
):
  | { file_id: string; markdown: string; create_if_missing?: boolean; parent_folder_id?: string; name?: string }
  | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  const markdown = typeof o.markdown === 'string' ? o.markdown : null;
  if (markdown === null) return '`markdown` (string) is required';
  return {
    file_id: fileId,
    markdown,
    create_if_missing: typeof o.create_if_missing === 'boolean' ? o.create_if_missing : undefined,
    parent_folder_id: asString(o, 'parent_folder_id') ?? undefined,
    name: asString(o, 'name') ?? undefined,
  };
}

function validateSheetRead(raw: unknown): { spreadsheet_id: string; range: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const id = asString(o, 'spreadsheet_id');
  if (!id) return '`spreadsheet_id` (string) is required';
  const range = asString(o, 'range');
  if (!range) return '`range` (string, A1 notation) is required';
  return { spreadsheet_id: id, range };
}

function validateSheetWrite(
  raw: unknown,
): { spreadsheet_id: string; range: string; values: string[][]; value_input_option?: 'RAW' | 'USER_ENTERED' } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const id = asString(o, 'spreadsheet_id');
  if (!id) return '`spreadsheet_id` (string) is required';
  const range = asString(o, 'range');
  if (!range) return '`range` (string, A1 notation) is required';
  const values = o.values;
  if (!Array.isArray(values)) return '`values` (string[][]) is required';
  if (!values.every((row) => Array.isArray(row))) return '`values` must be a 2D array (string[][])';
  const opt = o.value_input_option;
  if (opt !== undefined && opt !== 'RAW' && opt !== 'USER_ENTERED') {
    return '`value_input_option`, when provided, must be "RAW" or "USER_ENTERED"';
  }
  return {
    spreadsheet_id: id,
    range,
    values: values as string[][],
    value_input_option: opt as 'RAW' | 'USER_ENTERED' | undefined,
  };
}

function validateSlidesCreate(raw: unknown): { title?: string; parent_folder_id?: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  // No required fields. Title defaults to "Untitled"; parent_folder_id is optional.
  return {
    title: asString(o, 'title') ?? undefined,
    parent_folder_id: asString(o, 'parent_folder_id') ?? undefined,
  };
}

function validateSlidesAppend(raw: unknown): { presentation_id: string; layout?: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const id = asString(o, 'presentation_id');
  if (!id) return '`presentation_id` (string) is required';
  return { presentation_id: id, layout: asString(o, 'layout') ?? undefined };
}

function validateSlidesReplaceText(
  raw: unknown,
): { presentation_id: string; find: string; replace_with: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const id = asString(o, 'presentation_id');
  if (!id) return '`presentation_id` (string) is required';
  const find = typeof o.find === 'string' ? o.find : null;
  if (find === null || find.length === 0) return '`find` (non-empty string) is required';
  const replaceWith = typeof o.replace_with === 'string' ? o.replace_with : null;
  if (replaceWith === null) return '`replace_with` (string) is required';
  return { presentation_id: id, find, replace_with: replaceWith };
}

// Mutable registry — populated below by built-in registerGwsTool calls,
// and extensible at module-load time by extensions
// (e.g., classroom-gws's ownership module in Phase R.2+).
const TOOL_REGISTRY: Partial<Record<string, ToolEntry<unknown>>> = {};

/**
 * Register a GWS tool into the in-process registry. Called at module
 * load — built-in V1 tools register themselves below; extensions
 * (installed by skills like /add-classroom-gws) self-register via
 * the same call.
 *
 * Last-registration-wins for a given name; this lets an extension
 * override a base tool's behavior if needed (rare).
 */
export function registerGwsTool(
  name: string,
  entry: { handler: ToolEntry<unknown>['handler']; validate: ToolEntry<unknown>['validate'] },
): void {
  TOOL_REGISTRY[name] = { name, handler: entry.handler, validate: entry.validate };
}

registerGwsTool('drive_doc_read_as_markdown', {
  handler: driveDocReadAsMarkdown,
  validate: validateRead as (raw: unknown) => unknown | string,
});
registerGwsTool('drive_doc_write_from_markdown', {
  handler: driveDocWriteFromMarkdown,
  validate: validateWrite as (raw: unknown) => unknown | string,
});
registerGwsTool('sheet_read_range', {
  handler: sheetReadRange,
  validate: validateSheetRead as (raw: unknown) => unknown | string,
});
registerGwsTool('sheet_write_range', {
  handler: sheetWriteRange,
  validate: validateSheetWrite as (raw: unknown) => unknown | string,
});
registerGwsTool('slides_create_deck', {
  handler: slidesCreateDeck,
  validate: validateSlidesCreate as (raw: unknown) => unknown | string,
});
registerGwsTool('slides_append_slide', {
  handler: slidesAppendSlide,
  validate: validateSlidesAppend as (raw: unknown) => unknown | string,
});
registerGwsTool('slides_replace_text', {
  handler: slidesReplaceText,
  validate: validateSlidesReplaceText as (raw: unknown) => unknown | string,
});

/** Names of every registered tool — used by the relay's introspection
 * endpoint and by tests. */
export function listToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

/**
 * Dispatch a tool call. Validates args first; on failure returns a
 * `ToolError` with status 400. Unknown tool name returns 404. Any
 * unhandled exception inside the tool becomes a 500. Otherwise returns
 * whatever the tool returned.
 */
export async function dispatchTool(opts: { ctx: ToolContext; toolName: string; args: unknown }): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[opts.toolName];
  if (!entry) {
    return { ok: false, error: `Unknown tool: ${opts.toolName}`, status: 404 };
  }
  const validatedOrError = entry.validate(opts.args);
  if (typeof validatedOrError === 'string') {
    return { ok: false, error: `Invalid arguments: ${validatedOrError}`, status: 400 };
  }
  try {
    const result = (await entry.handler(opts.ctx, validatedOrError)) as ToolResult;
    return result;
  } catch (err) {
    return { ok: false, error: `Tool ${opts.toolName} threw: ${(err as Error).message}`, status: 500 };
  }
}
