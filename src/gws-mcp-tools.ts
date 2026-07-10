/**
 * Google Workspace MCP tools — V1 surface (Phase 13.2).
 *
 * Two tools that close the gap rclone leaves: rclone makes Drive files
 * look like a normal filesystem (great for bash + Read/Write), but
 * binary `.gdoc` pointers aren't editable. These tools give agents
 * editable text:
 *
 *   - `drive_doc_read_as_markdown(file_id)` — fetches a Google Doc and
 *     exports it as markdown via the Drive `export` endpoint. Returns
 *     the markdown string.
 *   - `drive_doc_write_from_markdown(file_id, markdown, opts?)` —
 *     overwrites an existing Doc's content with the supplied markdown,
 *     using Drive's `update` endpoint with mimeType conversion. With
 *     `create_if_missing: true` and a parent folder, will create a new
 *     Doc instead.
 *
 * Path-based lookup ("find a Doc named X under student folder Y") is
 * deferred — V1 takes file_ids only. Path resolution would land via
 * `@googleapis/drive`'s `files.list` with a `q=` query; tracked for a
 * V2 follow-up.
 *
 * OAuth: each tool resolves its access token via
 * `getGoogleAccessTokenForAgentGroup(agentGroupId)` so per-student
 * isolation Just Works once the class deployment wires it.
 */
import { Readable } from 'stream';

import { drive as driveApi, auth as gAuth } from '@googleapis/drive';
import { sheets as sheetsApi } from '@googleapis/sheets';
import { slides as slidesApi } from '@googleapis/slides';

import { getGoogleAccessTokenForAgentGroup } from './gws-token.js';
import { log } from './log.js';

export interface ToolContext {
  agentGroupId: string | null;
}

export interface ToolError {
  ok: false;
  error: string;
  status?: number;
  reason?: 'connect_required';
}

export interface DocReadResult {
  ok: true;
  fileId: string;
  markdown: string;
  bytes: number;
  principal: 'self';
}

export interface DocWriteResult {
  ok: true;
  fileId: string;
  bytes: number;
  created: boolean;
  principal: 'self';
}

// Exported so extension modules (e.g., src/gws-ownership-ext.ts) can
// reuse the same client construction without re-importing @googleapis/drive.
export function buildDriveClient(accessToken: string): ReturnType<typeof driveApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return driveApi({ version: 'v3', auth: oauth });
}

export interface ResolvedToken {
  token: string;
  principal: 'self';
}

type DriveClient = ReturnType<typeof driveApi>;

/**
 * Extension hook context: passed to pre-mutation / post-create hooks so
 * extensions (e.g., classroom Mode A ownership) can decide whether to
 * fire based on principal / agentGroupId without re-resolving anything.
 */
export interface HookContext {
  drive: DriveClient;
  fileId: string;
  ctx: ToolContext;
  resolved: ResolvedToken;
}

/**
 * Pre-mutation hook: runs before a Drive write/update. Return
 * `{ ok: true }` to allow, `ToolError` to block (returned to caller
 * verbatim — status preserved). Extra ok fields are tolerated.
 */
export type PreMutationHook = (h: HookContext) => Promise<{ ok: true } | ToolError>;

/**
 * Post-create hook: runs after a successful `files.create` (e.g., on
 * the create-if-missing fallback). Best-effort — exceptions are
 * swallowed so they don't fail the user-visible "file was created"
 * result. Extensions: ownership tag stamping, anyone-with-link share.
 */
export type PostCreateHook = (h: HookContext) => Promise<void>;

const preMutationHooks: PreMutationHook[] = [];
const postCreateHooks: PostCreateHook[] = [];

/** Register a hook that runs before any Drive write/update. */
export function registerPreMutationHook(hook: PreMutationHook): void {
  preMutationHooks.push(hook);
}

/** Register a hook that runs after a successful Drive create. */
export function registerPostCreateHook(hook: PostCreateHook): void {
  postCreateHooks.push(hook);
}

/** Test hook — drop all registered hooks. Used by extension tests. */
export function _resetHooksForTest(): void {
  preMutationHooks.length = 0;
  postCreateHooks.length = 0;
}

// Exported for extension modules — same reasoning as buildDriveClient.
//
// No `requirePersonal` option: every remaining tool (Drive/Sheets/Slides)
// requires the caller's own Google token unconditionally — there is no
// second mode to opt into, so a flag that can only ever be `true` was
// removed rather than threaded through every call site.
export async function resolveTokenOrError(ctx: ToolContext): Promise<ResolvedToken | ToolError> {
  const resolved = await getGoogleAccessTokenForAgentGroup(ctx.agentGroupId);
  if (!resolved) {
    return {
      ok: false,
      error: 'Connect your Google account first. Open the home tab in the playground and click "Connect Google".',
      status: 403,
      reason: 'connect_required',
    };
  }
  return resolved;
}

/**
 * Drive `export` endpoint converts a Google Doc to a chosen mimeType
 * server-side. `text/markdown` is officially supported. Returns the
 * markdown text directly.
 */
export async function driveDocReadAsMarkdown(
  ctx: ToolContext,
  args: { file_id: string },
): Promise<DocReadResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  try {
    const res = await drive.files.export({ fileId: args.file_id, mimeType: 'text/markdown' }, { responseType: 'text' });
    const markdown = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    return {
      ok: true,
      fileId: args.file_id,
      markdown,
      bytes: Buffer.byteLength(markdown),
      principal: tokenOrError.principal,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('drive_doc_read_as_markdown failed', { fileId: args.file_id, status, err: String(err) });
    return {
      ok: false,
      error: `Drive export failed for ${args.file_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Drive `update` (with mimeType conversion) replaces a Google Doc's
 * content in-place — Drive accepts `text/markdown` as the source
 * media and stores the result as `application/vnd.google-apps.document`.
 *
 * With `opts.create_if_missing` + `opts.parent_folder_id` set and the
 * file_id missing on Drive, falls through to `files.create` instead so
 * a single tool call can do "make-or-update."
 */
export async function driveDocWriteFromMarkdown(
  ctx: ToolContext,
  args: {
    file_id: string;
    markdown: string;
    create_if_missing?: boolean;
    parent_folder_id?: string;
    name?: string;
  },
): Promise<DocWriteResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  // Pre-mutation hooks (registered by extensions, e.g., classroom Mode A
  // ownership). Each hook decides internally whether to fire based on
  // resolved.principal / ctx.agentGroupId. First blocking hook wins.
  for (const hook of preMutationHooks) {
    const result = await hook({ drive, fileId: args.file_id, ctx, resolved: tokenOrError });
    if (!result.ok) return result;
  }

  try {
    const res = await drive.files.update({
      fileId: args.file_id,
      media: {
        mimeType: 'text/markdown',
        body: Readable.from([args.markdown]),
      },
      requestBody: { mimeType: 'application/vnd.google-apps.document' },
    });
    return {
      ok: true,
      fileId: res.data.id || args.file_id,
      bytes: Buffer.byteLength(args.markdown),
      created: false,
      principal: tokenOrError.principal,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    if (status === 404 && args.create_if_missing) {
      try {
        const create = await drive.files.create({
          requestBody: {
            name: args.name ?? 'Untitled',
            mimeType: 'application/vnd.google-apps.document',
            parents: args.parent_folder_id ? [args.parent_folder_id] : undefined,
          },
          media: {
            mimeType: 'text/markdown',
            body: Readable.from([args.markdown]),
          },
        });
        const newId = create.data.id ?? '';
        if (newId) {
          for (const hook of postCreateHooks) {
            try {
              await hook({ drive, fileId: newId, ctx, resolved: tokenOrError });
            } catch (hookErr) {
              log.warn('drive_doc_write_from_markdown: post-create hook threw', {
                fileId: newId,
                err: String(hookErr),
              });
            }
          }
        }
        return {
          ok: true,
          fileId: newId,
          bytes: Buffer.byteLength(args.markdown),
          created: true,
          principal: tokenOrError.principal,
        };
      } catch (createErr) {
        log.warn('drive_doc_write_from_markdown create fallback failed', {
          fileId: args.file_id,
          err: String(createErr),
        });
        return {
          ok: false,
          error: `Drive create failed for ${args.file_id}: ${(createErr as Error).message}`,
          status: 500,
        };
      }
    }
    log.warn('drive_doc_write_from_markdown failed', { fileId: args.file_id, status, err: String(err) });
    return {
      ok: false,
      error: `Drive update failed for ${args.file_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Sheets (Phase 13.5a — V2 surface)
//
// Spreadsheets are Drive files, so writes reuse the existing
// pre-mutation hook chain (claimOrCheckDriveOwnership runs against the
// spreadsheet_id). No new ownership infrastructure needed.
// ────────────────────────────────────────────────────────────────────

export interface SheetReadResult {
  ok: true;
  spreadsheetId: string;
  range: string;
  values: string[][];
  cells: number;
  principal: 'self';
}

export interface SheetWriteResult {
  ok: true;
  spreadsheetId: string;
  range: string;
  updatedCells: number;
  principal: 'self';
}

function buildSheetsClient(accessToken: string): ReturnType<typeof sheetsApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return sheetsApi({ version: 'v4', auth: oauth });
}

/**
 * Read a range from a Google Sheet via `spreadsheets.values.get`.
 * No ownership check — reads are open in Mode A (workspace shared) and
 * scoped by Google in Mode B.
 */
export async function sheetReadRange(
  ctx: ToolContext,
  args: { spreadsheet_id: string; range: string },
): Promise<SheetReadResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const sheets = buildSheetsClient(tokenOrError.token);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: args.spreadsheet_id,
      range: args.range,
    });
    const rawValues = (res.data.values ?? []) as unknown[][];
    const values: string[][] = rawValues.map((row) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
    );
    const cells = values.reduce((sum, row) => sum + row.length, 0);
    return {
      ok: true,
      spreadsheetId: args.spreadsheet_id,
      range: args.range,
      values,
      cells,
      principal: tokenOrError.principal,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('sheet_read_range failed', { spreadsheetId: args.spreadsheet_id, range: args.range, err: String(err) });
    return {
      ok: false,
      error: `Sheets read failed for ${args.spreadsheet_id}!${args.range}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Write a 2D `values` array into the given A1-notation range using
 * `spreadsheets.values.update`. Runs all registered pre-mutation hooks
 * first (Mode A ownership check against the spreadsheet_id, etc.).
 *
 * `value_input_option` defaults to `'USER_ENTERED'` so formulas
 * starting with `=` evaluate; switch to `'RAW'` to store them as
 * literal strings.
 */
export async function sheetWriteRange(
  ctx: ToolContext,
  args: {
    spreadsheet_id: string;
    range: string;
    values: string[][];
    value_input_option?: 'RAW' | 'USER_ENTERED';
  },
): Promise<SheetWriteResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  // Pre-mutation hooks (Mode A ownership). Same chain as Doc writes —
  // spreadsheet_id is a Drive file id, so the existing Drive ownership
  // primitive applies unchanged.
  for (const hook of preMutationHooks) {
    const result = await hook({ drive, fileId: args.spreadsheet_id, ctx, resolved: tokenOrError });
    if (!result.ok) return result;
  }

  const sheets = buildSheetsClient(tokenOrError.token);
  try {
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId: args.spreadsheet_id,
      range: args.range,
      valueInputOption: args.value_input_option ?? 'USER_ENTERED',
      requestBody: { values: args.values },
    });
    return {
      ok: true,
      spreadsheetId: args.spreadsheet_id,
      range: args.range,
      updatedCells: res.data.updatedCells ?? 0,
      principal: tokenOrError.principal,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('sheet_write_range failed', { spreadsheetId: args.spreadsheet_id, range: args.range, err: String(err) });
    return {
      ok: false,
      error: `Sheets write failed for ${args.spreadsheet_id}!${args.range}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Slides (Phase 13.5e — V2 surface)
//
// Slides decks are Drive files, so writes reuse the existing
// pre-mutation hook chain and create reuses the existing post-create
// hook chain (Mode A ownership tag + anyone-with-link share). No new
// ownership infrastructure needed.
// ────────────────────────────────────────────────────────────────────

export interface SlidesCreateResult {
  ok: true;
  presentationId: string;
  webViewLink: string | null;
  principal: 'self';
}

export interface SlidesAppendResult {
  ok: true;
  presentationId: string;
  slideId: string;
  principal: 'self';
}

export interface SlidesReplaceTextResult {
  ok: true;
  presentationId: string;
  occurrencesChanged: number;
  principal: 'self';
}

function buildSlidesClient(accessToken: string): ReturnType<typeof slidesApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return slidesApi({ version: 'v1', auth: oauth });
}

/**
 * Create a new Slides presentation. Uses Drive's `files.create` so we
 * can drop it directly into `parent_folder_id` if supplied (Slides API's
 * `presentations.create` lands the file in the user's root with no way
 * to specify a parent). After creation, post-create hooks fire (Mode A
 * stamps owner tag + applies anyone-with-link share).
 */
export async function slidesCreateDeck(
  ctx: ToolContext,
  args: { title?: string; parent_folder_id?: string },
): Promise<SlidesCreateResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);
  try {
    const res = await drive.files.create({
      requestBody: {
        name: args.title ?? 'Untitled',
        mimeType: 'application/vnd.google-apps.presentation',
        parents: args.parent_folder_id ? [args.parent_folder_id] : undefined,
      },
      fields: 'id,webViewLink',
    });
    const presentationId = res.data.id ?? '';
    for (const hook of postCreateHooks) {
      try {
        await hook({ drive, fileId: presentationId, ctx, resolved: tokenOrError });
      } catch (hookErr) {
        log.warn('slides_create_deck: post-create hook threw', { presentationId, err: String(hookErr) });
      }
    }
    return { ok: true, presentationId, webViewLink: res.data.webViewLink ?? null, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('slides_create_deck failed', { title: args.title, err: String(err) });
    return {
      ok: false,
      error: `Slides create failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Append a blank (or layout-specified) slide to an existing deck via
 * `presentations.batchUpdate` with a `createSlide` request. Runs
 * pre-mutation hooks first (Mode A ownership check).
 *
 * Common `layout` values: `BLANK`, `TITLE`, `TITLE_AND_BODY`,
 * `SECTION_HEADER`, etc. — passes through to Slides API; invalid layouts
 * surface as a 400 from Google with the error message intact.
 */
export async function slidesAppendSlide(
  ctx: ToolContext,
  args: { presentation_id: string; layout?: string },
): Promise<SlidesAppendResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  for (const hook of preMutationHooks) {
    const result = await hook({ drive, fileId: args.presentation_id, ctx, resolved: tokenOrError });
    if (!result.ok) return result;
  }

  const slides = buildSlidesClient(tokenOrError.token);
  try {
    const res = await slides.presentations.batchUpdate({
      presentationId: args.presentation_id,
      requestBody: {
        requests: [
          {
            createSlide: {
              slideLayoutReference: { predefinedLayout: args.layout ?? 'BLANK' },
            },
          },
        ],
      },
    });
    const reply = res.data.replies?.[0];
    const slideId = reply?.createSlide?.objectId ?? '';
    return { ok: true, presentationId: args.presentation_id, slideId, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('slides_append_slide failed', { presentationId: args.presentation_id, err: String(err) });
    return {
      ok: false,
      error: `Slides append failed for ${args.presentation_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Find/replace text across all slides in a deck via
 * `presentations.batchUpdate` with a `replaceAllText` request. Runs
 * pre-mutation hooks first.
 *
 * Case-sensitive by default. Returns the number of replacements made
 * (0 is a successful no-op, not an error).
 */
export async function slidesReplaceText(
  ctx: ToolContext,
  args: { presentation_id: string; find: string; replace_with: string },
): Promise<SlidesReplaceTextResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  for (const hook of preMutationHooks) {
    const result = await hook({ drive, fileId: args.presentation_id, ctx, resolved: tokenOrError });
    if (!result.ok) return result;
  }

  const slides = buildSlidesClient(tokenOrError.token);
  try {
    const res = await slides.presentations.batchUpdate({
      presentationId: args.presentation_id,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: args.find, matchCase: true },
              replaceText: args.replace_with,
            },
          },
        ],
      },
    });
    const reply = res.data.replies?.[0];
    const occurrencesChanged = reply?.replaceAllText?.occurrencesChanged ?? 0;
    return { ok: true, presentationId: args.presentation_id, occurrencesChanged, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('slides_replace_text failed', { presentationId: args.presentation_id, err: String(err) });
    return {
      ok: false,
      error: `Slides replace-text failed for ${args.presentation_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}
