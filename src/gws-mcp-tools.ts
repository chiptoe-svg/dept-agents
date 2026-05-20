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

import { calendar as calendarApi } from '@googleapis/calendar';
import { drive as driveApi, auth as gAuth } from '@googleapis/drive';
import { gmail as gmailApi } from '@googleapis/gmail';
import { sheets as sheetsApi } from '@googleapis/sheets';
import { slides as slidesApi } from '@googleapis/slides';

import { getGoogleAccessTokenForAgentGroup, type GwsPrincipal } from './gws-token.js';
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
  principal: GwsPrincipal;
}

export interface DocWriteResult {
  ok: true;
  fileId: string;
  bytes: number;
  created: boolean;
  principal: GwsPrincipal;
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
  principal: GwsPrincipal;
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
export async function resolveTokenOrError(
  ctx: ToolContext,
  options?: { requirePersonal?: boolean },
): Promise<ResolvedToken | ToolError> {
  const resolved = await getGoogleAccessTokenForAgentGroup(ctx.agentGroupId, options);
  if (!resolved) {
    if (options?.requirePersonal) {
      return {
        ok: false,
        error:
          'Connect your Google account to use Gmail. Open the home tab in the playground and click "Connect Google".',
        status: 403,
        reason: 'connect_required',
      };
    }
    return {
      ok: false,
      error:
        'No Google OAuth token available — instructor needs ~/.config/gws/credentials.json or the student needs to complete /add-classroom-auth.',
      status: 502,
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
  principal: GwsPrincipal;
}

export interface SheetWriteResult {
  ok: true;
  spreadsheetId: string;
  range: string;
  updatedCells: number;
  principal: GwsPrincipal;
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
  principal: GwsPrincipal;
}

export interface SlidesAppendResult {
  ok: true;
  presentationId: string;
  slideId: string;
  principal: GwsPrincipal;
}

export interface SlidesReplaceTextResult {
  ok: true;
  presentationId: string;
  occurrencesChanged: number;
  principal: GwsPrincipal;
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

// ────────────────────────────────────────────────────────────────────
// Gmail (Phase 14 Tier C)
//
// All three tools require the student's personal Google account
// (requirePersonal: true). No instructor fallback — these tools are
// explicitly gated.
// ────────────────────────────────────────────────────────────────────

function buildGmailClient(accessToken: string): ReturnType<typeof gmailApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return gmailApi({ version: 'v1', auth: oauth });
}

/** A single message summary returned by gmail_search. */
export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  date: string;
}

export interface GmailSearchResult {
  ok: true;
  messages: GmailMessage[];
  principal: GwsPrincipal;
}

/** A single message in a full thread (gmail_read_thread). */
export interface GmailThreadMessage {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  body: string;
}

export interface GmailReadThreadResult {
  ok: true;
  threadId: string;
  messages: GmailThreadMessage[];
  principal: GwsPrincipal;
}

export interface GmailSendDraftResult {
  ok: true;
  draftId: string;
  messageId: string;
  threadId: string;
  composeUrl: string;
  principal: GwsPrincipal;
}

/** Extract a named header from a Gmail message headers array. */
function extractHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  const lc = name.toLowerCase();
  return headers.find((h) => (h.name ?? '').toLowerCase() === lc)?.value ?? '';
}

/**
 * Decode a base64url-encoded string to UTF-8 text. Gmail encodes
 * message body parts in base64url (RFC 4648 §5).
 */
function decodeBase64Url(encoded: string): string {
  // base64url → base64: replace - with + and _ with /
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf-8');
}

/** Strip HTML tags — simple regex, good enough for email body fallback. */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Walk a Gmail MIME part tree and extract the best-available body:
 * prefer text/plain; fall back to text/html (stripped of tags).
 */
function extractBody(part: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[] | null;
}): string {
  // Leaf node
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtmlTags(decodeBase64Url(part.body.data));
  }

  // Multipart: recurse and collect
  if (Array.isArray(part.parts)) {
    const subParts = part.parts as (typeof part)[];
    // Prefer plain text first
    for (const sub of subParts) {
      if (sub.mimeType === 'text/plain' && sub.body?.data) {
        return decodeBase64Url(sub.body.data);
      }
    }
    // Try nested multipart recursively
    for (const sub of subParts) {
      const result = extractBody(sub);
      if (result) return result;
    }
  }

  return '';
}

const MAX_CONCURRENT_FETCHES = 10;
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 50;

/**
 * Search the student's Gmail inbox and return message summaries.
 */
export async function gmailSearch(
  ctx: ToolContext,
  args: { query: string; max_results?: number },
): Promise<GmailSearchResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const gmail = buildGmailClient(tokenOrError.token);

  const maxResults = Math.min(args.max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

  try {
    const listRes = await gmail.users.messages.list({ userId: 'me', q: args.query, maxResults });
    const rawMessages = listRes.data.messages ?? [];

    // Fetch details in parallel, capped at MAX_CONCURRENT_FETCHES at a time
    const messages: GmailMessage[] = [];
    for (let i = 0; i < rawMessages.length; i += MAX_CONCURRENT_FETCHES) {
      const chunk = rawMessages.slice(i, i + MAX_CONCURRENT_FETCHES);
      const details = await Promise.all(
        chunk.map((m) =>
          gmail.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          }),
        ),
      );
      for (const detail of details) {
        const headers = detail.data.payload?.headers ?? [];
        messages.push({
          id: detail.data.id ?? '',
          threadId: detail.data.threadId ?? '',
          snippet: detail.data.snippet ?? '',
          subject: extractHeader(headers, 'Subject'),
          from: extractHeader(headers, 'From'),
          date: extractHeader(headers, 'Date'),
        });
      }
    }

    return { ok: true, messages, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('gmail_search failed', { query: args.query, err: String(err) });
    return {
      ok: false,
      error: `Gmail search failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Read a full Gmail thread by ID, returning each message with decoded body.
 */
export async function gmailReadThread(
  ctx: ToolContext,
  args: { thread_id: string },
): Promise<GmailReadThreadResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const gmail = buildGmailClient(tokenOrError.token);

  try {
    const res = await gmail.users.threads.get({ userId: 'me', id: args.thread_id, format: 'full' });
    const rawMsgs = res.data.messages ?? [];

    const messages: GmailThreadMessage[] = rawMsgs.map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const body = extractBody((msg.payload as Parameters<typeof extractBody>[0]) ?? { mimeType: undefined });
      const cc = extractHeader(headers, 'Cc');
      const result: GmailThreadMessage = {
        id: msg.id ?? '',
        from: extractHeader(headers, 'From'),
        to: extractHeader(headers, 'To'),
        subject: extractHeader(headers, 'Subject'),
        date: extractHeader(headers, 'Date'),
        body,
      };
      if (cc) result.cc = cc;
      return result;
    });

    return { ok: true, threadId: args.thread_id, messages, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('gmail_read_thread failed', { threadId: args.thread_id, err: String(err) });
    return {
      ok: false,
      error: `Gmail read thread failed for ${args.thread_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Build an RFC 2822 message string and base64url-encode it.
 * Handles multi-recipient `to` and optional `cc` arrays.
 */
function buildRawMessage(opts: {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  from?: string;
}): string {
  const toHeader = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
  const lines: string[] = [
    `To: ${toHeader}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ];
  if (opts.cc) {
    const ccHeader = Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc;
    lines.push(`Cc: ${ccHeader}`);
  }
  lines.push('', opts.body);
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ────────────────────────────────────────────────────────────────────
// Calendar (Phase 14 Tier D)
//
// All three tools require the student's personal Google account
// (requirePersonal: true). No instructor fallback — same gate as Gmail.
// ────────────────────────────────────────────────────────────────────

function buildCalendarClient(accessToken: string): ReturnType<typeof calendarApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return calendarApi({ version: 'v3', auth: oauth });
}

/** A single event returned by calendar_list_events. */
export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  htmlLink: string;
}

export interface CalendarListEventsResult {
  ok: true;
  events: CalendarEvent[];
  principal: GwsPrincipal;
}

export interface CalendarCreateEventResult {
  ok: true;
  eventId: string;
  htmlLink: string;
  principal: GwsPrincipal;
}

export interface CalendarFreeSlot {
  start: string;
  end: string;
}

export interface CalendarFindFreeSlotResult {
  ok: true;
  slots: CalendarFreeSlot[];
  principal: GwsPrincipal;
}

/** Map Google's { dateTime?, date? } to a single ISO-8601 string. */
function resolveEventTime(t: { dateTime?: string | null; date?: string | null } | null | undefined): string {
  if (!t) return '';
  if (t.dateTime) return t.dateTime;
  if (t.date) return `${t.date}T00:00:00Z`;
  return '';
}

const CALENDAR_DEFAULT_MAX_RESULTS = 50;
const CALENDAR_MAX_RESULTS_CAP = 250;

/**
 * List events on the student's primary calendar in a time window.
 */
export async function calendarListEvents(
  ctx: ToolContext,
  args: { time_min: string; time_max: string; max_results?: number },
): Promise<CalendarListEventsResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const cal = buildCalendarClient(tokenOrError.token);

  const maxResults = Math.min(args.max_results ?? CALENDAR_DEFAULT_MAX_RESULTS, CALENDAR_MAX_RESULTS_CAP);

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: args.time_min,
      timeMax: args.time_max,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const rawItems = res.data.items ?? [];
    const events: CalendarEvent[] = rawItems.map((item) => {
      const event: CalendarEvent = {
        id: item.id ?? '',
        summary: item.summary ?? '',
        start: resolveEventTime(item.start),
        end: resolveEventTime(item.end),
        htmlLink: item.htmlLink ?? '',
      };
      if (item.description) event.description = item.description;
      if (item.location) event.location = item.location;
      if (item.attendees && item.attendees.length > 0) {
        event.attendees = item.attendees
          .filter((a) => a.email)
          .map((a) => {
            const entry: { email: string; responseStatus?: string } = { email: a.email! };
            if (a.responseStatus) entry.responseStatus = a.responseStatus;
            return entry;
          });
      }
      return event;
    });

    return { ok: true, events, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('calendar_list_events failed', { timeMin: args.time_min, timeMax: args.time_max, err: String(err) });
    return {
      ok: false,
      error: `Calendar list events failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/** Determine whether a start/end pair represents an all-day event. */
function isAllDay(isoString: string): boolean {
  // All-day strings end with T00:00:00Z after normalization (from date-only input)
  // OR the original arg might be a bare date like "2026-05-20"
  return /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(isoString) || /^\d{4}-\d{2}-\d{2}$/.test(isoString);
}

/** Normalize attendees: accept string[] or { email }[] — always produce { email }[]. */
function normalizeAttendees(raw: Array<{ email: string } | string> | undefined): Array<{ email: string }> | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((a) => (typeof a === 'string' ? { email: a } : { email: a.email }));
}

/**
 * Create an event on the student's primary calendar.
 */
export async function calendarCreateEvent(
  ctx: ToolContext,
  args: {
    start: string;
    end: string;
    summary: string;
    description?: string;
    location?: string;
    attendees?: Array<{ email: string } | string>;
  },
): Promise<CalendarCreateEventResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const cal = buildCalendarClient(tokenOrError.token);

  // Detect all-day: both start and end are date-only or midnight-Z
  const allDay = isAllDay(args.start) && isAllDay(args.end);

  // Strip to date portion for all-day events
  const toDate = (s: string) => s.slice(0, 10);

  const requestBody: {
    summary: string;
    description?: string;
    location?: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    attendees?: Array<{ email: string }>;
  } = {
    summary: args.summary,
    start: allDay ? { date: toDate(args.start) } : { dateTime: args.start },
    end: allDay ? { date: toDate(args.end) } : { dateTime: args.end },
  };

  if (args.description) requestBody.description = args.description;
  if (args.location) requestBody.location = args.location;
  const attendees = normalizeAttendees(args.attendees);
  if (attendees) requestBody.attendees = attendees;

  try {
    const res = await cal.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody,
    });

    return {
      ok: true,
      eventId: res.data.id ?? '',
      htmlLink: res.data.htmlLink ?? '',
      principal: tokenOrError.principal,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('calendar_create_event failed', { summary: args.summary, err: String(err) });
    return {
      ok: false,
      error: `Calendar create event failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

const CALENDAR_DEFAULT_MAX_SLOTS = 5;

/**
 * Find free time slots in a window by listing events and computing gaps.
 * Skips events with transparency === 'transparent' (free / unblocking).
 * All-day events block the entire day.
 */
export async function calendarFindFreeSlot(
  ctx: ToolContext,
  args: { duration_minutes: number; time_min: string; time_max: string; max_slots?: number },
): Promise<CalendarFindFreeSlotResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const cal = buildCalendarClient(tokenOrError.token);

  const maxSlots = args.max_slots ?? CALENDAR_DEFAULT_MAX_SLOTS;
  const durationMs = args.duration_minutes * 60_000;

  try {
    // Fetch all events in the window (up to cap)
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: args.time_min,
      timeMax: args.time_max,
      maxResults: CALENDAR_MAX_RESULTS_CAP,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const windowStart = new Date(args.time_min).getTime();
    const windowEnd = new Date(args.time_max).getTime();

    // Build sorted list of busy intervals, skipping transparent events
    const busy: Array<{ start: number; end: number }> = [];
    for (const item of res.data.items ?? []) {
      if (item.transparency === 'transparent') continue;

      let start: number;
      let end: number;

      if (item.start?.date) {
        // All-day event: block entire day(s)
        start = new Date(`${item.start.date}T00:00:00Z`).getTime();
        const endDate = item.end?.date ?? item.start.date;
        end = new Date(`${endDate}T00:00:00Z`).getTime();
        // Google Calendar all-day end is exclusive (next day at midnight)
        // so end is already correct as a boundary
      } else {
        start = new Date(item.start?.dateTime ?? args.time_min).getTime();
        end = new Date(item.end?.dateTime ?? args.time_max).getTime();
      }

      // Clamp to window
      start = Math.max(start, windowStart);
      end = Math.min(end, windowEnd);
      if (start < end) busy.push({ start, end });
    }

    // Sort by start time (should already be ordered, but defensive)
    busy.sort((a, b) => a.start - b.start);

    // Walk gaps: [windowStart, first event), between events, (last event, windowEnd]
    const slots: CalendarFreeSlot[] = [];
    let cursor = windowStart;

    for (const interval of busy) {
      const gapEnd = interval.start;
      if (gapEnd - cursor >= durationMs) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(gapEnd).toISOString(),
        });
        if (slots.length >= maxSlots) break;
      }
      // Advance cursor past this event
      cursor = Math.max(cursor, interval.end);
    }

    // Trailing gap after last event
    if (slots.length < maxSlots && windowEnd - cursor >= durationMs) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(windowEnd).toISOString(),
      });
    }

    return { ok: true, slots, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('calendar_find_free_slot failed', { timeMin: args.time_min, timeMax: args.time_max, err: String(err) });
    return {
      ok: false,
      error: `Calendar find free slot failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Create a Gmail draft (never sends automatically). Returns the draft ID
 * and a composeUrl deep link so the student can review and send manually.
 */
export async function gmailSendDraft(
  ctx: ToolContext,
  args: {
    to: string | string[];
    subject: string;
    body: string;
    cc?: string | string[];
    in_reply_to_thread_id?: string;
  },
): Promise<GmailSendDraftResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx, { requirePersonal: true });
  if (!('principal' in tokenOrError)) return tokenOrError;
  const gmail = buildGmailClient(tokenOrError.token);

  const raw = buildRawMessage({ to: args.to, subject: args.subject, body: args.body, cc: args.cc });

  const messageBody: { raw: string; threadId?: string } = { raw };
  if (args.in_reply_to_thread_id) messageBody.threadId = args.in_reply_to_thread_id;

  try {
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: messageBody },
    });
    const draftId = res.data.id ?? '';
    const messageId = res.data.message?.id ?? '';
    const threadId = res.data.message?.threadId ?? '';
    const composeUrl = `https://mail.google.com/mail/u/0/#drafts/${messageId}`;
    return { ok: true, draftId, messageId, threadId, composeUrl, principal: tokenOrError.principal };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('gmail_send_draft failed', { to: args.to, subject: args.subject, err: String(err) });
    return {
      ok: false,
      error: `Gmail draft creation failed: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}
