/**
 * Integration tests for gws-mcp-tools.ts.
 *
 * Tier B: principal field on Drive success results.
 * Tier C: Gmail search, read-thread, send-draft — including connect_required
 *         gating when the student hasn't connected their personal Google account.
 *
 * Strategy: mock ./gws-token.js so getGoogleAccessTokenForAgentGroup
 * returns a controlled { token, principal } without hitting disk or the
 * network; mock @googleapis/* so no real HTTP is made. Then invoke each
 * SUT function and assert the expected shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── hoisted mock state ────────────────────────────────────────────────────────

const {
  mockGetGoogleAccessTokenForAgentGroup,
  mockFilesExport,
  mockMessagesListFn,
  mockMessagesGetFn,
  mockThreadsGetFn,
  mockDraftsCreateFn,
  mockCalendarEventsListFn,
  mockCalendarEventsInsertFn,
} = vi.hoisted(() => ({
  mockGetGoogleAccessTokenForAgentGroup: vi.fn(),
  mockFilesExport: vi.fn(),
  mockMessagesListFn: vi.fn(),
  mockMessagesGetFn: vi.fn(),
  mockThreadsGetFn: vi.fn(),
  mockDraftsCreateFn: vi.fn(),
  mockCalendarEventsListFn: vi.fn(),
  mockCalendarEventsInsertFn: vi.fn(),
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

vi.mock('@googleapis/gmail', () => {
  return {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesListFn,
          get: mockMessagesGetFn,
        },
        threads: {
          get: mockThreadsGetFn,
        },
        drafts: {
          create: mockDraftsCreateFn,
        },
      },
    })),
  };
});

vi.mock('@googleapis/calendar', () => {
  return {
    calendar: vi.fn(() => ({
      events: {
        list: mockCalendarEventsListFn,
        insert: mockCalendarEventsInsertFn,
      },
    })),
  };
});

// ── import SUT after mocks ────────────────────────────────────────────────────

import {
  driveDocReadAsMarkdown,
  gmailSearch,
  gmailReadThread,
  gmailSendDraft,
  calendarListEvents,
  calendarCreateEvent,
  calendarFindFreeSlot,
} from './gws-mcp-tools.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = { agentGroupId: 'ag_test' };
const FAKE_MARKDOWN = '# Hello\n\nWorld';

/** Wire mockFilesExport to return a successful export response. */
function stubDriveExportOk() {
  mockFilesExport.mockResolvedValue({ data: FAKE_MARKDOWN });
}

/** Build a base64url-encoded body the same way Gmail encodes it. */
function encodeBase64Url(text: string): string {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

  it('carries principal: "instructor-fallback" when resolver falls back to the instructor token', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({
      token: 'fake-instructor-token',
      principal: 'instructor-fallback',
    });

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_xyz' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('instructor-fallback');
    expect(result.fileId).toBe('doc_xyz');
  });

  it('returns ok:false (no principal) when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_nope' });

    expect(result.ok).toBe(false);
    expect('principal' in result).toBe(false);
  });
});

// ── Tier C: Gmail tests ───────────────────────────────────────────────────────

describe('gmailSearch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — returns messages with principal', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockMessagesListFn.mockResolvedValue({ data: { messages: [{ id: 'msg1' }, { id: 'msg2' }] } });
    mockMessagesGetFn.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({
        data: {
          id,
          threadId: `thread_${id}`,
          snippet: `snippet for ${id}`,
          payload: {
            headers: [
              { name: 'Subject', value: `Subject ${id}` },
              { name: 'From', value: `sender@example.com` },
              { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
            ],
          },
        },
      }),
    );

    const result = await gmailSearch(CTX, { query: 'is:unread' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: 'msg1',
      threadId: 'thread_msg1',
      subject: 'Subject msg1',
      from: 'sender@example.com',
    });
  });

  it('returns connect_required when resolver returns null (student not connected)', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailSearch(CTX, { query: 'test' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });

  it('respects max_results default and cap', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockMessagesListFn.mockResolvedValue({ data: { messages: [] } });

    await gmailSearch(CTX, { query: 'foo' });
    expect(mockMessagesListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 20 }));

    await gmailSearch(CTX, { query: 'foo', max_results: 100 });
    expect(mockMessagesListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 50 }));
  });
});

describe('gmailReadThread', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — decodes base64url plain-text body correctly', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });

    const plainBody = 'Hello, World!\nThis is a test email.';
    const encodedBody = encodeBase64Url(plainBody);

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread123',
        messages: [
          {
            id: 'msg123',
            threadId: 'thread123',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Test subject' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              body: { data: encodedBody },
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread123' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    expect(result.threadId).toBe('thread123');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toBe(plainBody);
    expect(result.messages[0].from).toBe('alice@example.com');
    expect(result.messages[0].subject).toBe('Test subject');
  });

  it('prefers plain text over HTML in a multipart message', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });

    const plainText = 'Plain version';
    const htmlText = '<p>HTML version</p>';

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread_mp',
        messages: [
          {
            id: 'msg_mp',
            threadId: 'thread_mp',
            payload: {
              mimeType: 'multipart/alternative',
              headers: [
                { name: 'From', value: 'x@y.com' },
                { name: 'To', value: 'z@w.com' },
                { name: 'Subject', value: 'Multipart' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              parts: [
                { mimeType: 'text/plain', body: { data: encodeBase64Url(plainText) } },
                { mimeType: 'text/html', body: { data: encodeBase64Url(htmlText) } },
              ],
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread_mp' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0].body).toBe(plainText);
  });

  it('falls back to stripped HTML when only HTML is present', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });

    const htmlText = '<p>Hello <strong>world</strong></p>';

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread_html',
        messages: [
          {
            id: 'msg_html',
            threadId: 'thread_html',
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'From', value: 'a@b.com' },
                { name: 'To', value: 'c@d.com' },
                { name: 'Subject', value: 'HTML only' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              body: { data: encodeBase64Url(htmlText) },
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread_html' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // HTML tags stripped, content preserved
    expect(result.messages[0].body).toContain('Hello');
    expect(result.messages[0].body).toContain('world');
    expect(result.messages[0].body).not.toContain('<p>');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailReadThread(CTX, { thread_id: 'thread_x' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });
});

describe('gmailSendDraft', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — includes composeUrl and returns draftId/messageId', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_abc',
        message: { id: 'msg_xyz', threadId: 'thread_xyz' },
      },
    });

    const result = await gmailSendDraft(CTX, {
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'This is the body.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draftId).toBe('draft_abc');
    expect(result.messageId).toBe('msg_xyz');
    expect(result.threadId).toBe('thread_xyz');
    expect(result.composeUrl).toBe('https://mail.google.com/mail/u/0/#drafts/msg_xyz');
    expect(result.principal).toBe('self');
  });

  it('happy path — passes threadId in requestBody when in_reply_to_thread_id set', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_reply',
        message: { id: 'msg_reply', threadId: 'thread_orig' },
      },
    });

    await gmailSendDraft(CTX, {
      to: 'a@b.com',
      subject: 'Re: something',
      body: 'Reply body',
      in_reply_to_thread_id: 'thread_orig',
    });

    const callArg = mockDraftsCreateFn.mock.calls[0][0] as {
      requestBody: { message: { threadId?: string } };
    };
    expect(callArg.requestBody.message.threadId).toBe('thread_orig');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailSendDraft(CTX, {
      to: 'x@y.com',
      subject: 'Test',
      body: 'Body',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });

  it('handles array `to` recipients', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_multi',
        message: { id: 'msg_multi', threadId: '' },
      },
    });

    const result = await gmailSendDraft(CTX, {
      to: ['a@example.com', 'b@example.com'],
      subject: 'Multi',
      body: 'Body',
    });

    expect(result.ok).toBe(true);
    // The raw message should have been built — check the draft was created
    expect(mockDraftsCreateFn).toHaveBeenCalledTimes(1);
  });
});

// ── Tier D: Calendar tests ────────────────────────────────────────────────────

describe('calendarListEvents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — returns events with principal', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt1',
            summary: 'Team standup',
            description: 'Daily sync',
            location: 'Zoom',
            start: { dateTime: '2026-05-20T09:00:00Z' },
            end: { dateTime: '2026-05-20T09:30:00Z' },
            htmlLink: 'https://calendar.google.com/evt1',
            attendees: [
              { email: 'alice@example.com', responseStatus: 'accepted' },
              { email: 'bob@example.com', responseStatus: 'needsAction' },
            ],
          },
          {
            id: 'evt2',
            summary: 'Lunch',
            start: { dateTime: '2026-05-20T12:00:00Z' },
            end: { dateTime: '2026-05-20T13:00:00Z' },
            htmlLink: 'https://calendar.google.com/evt2',
          },
        ],
      },
    });

    const result = await calendarListEvents(CTX, {
      time_min: '2026-05-20T00:00:00Z',
      time_max: '2026-05-21T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      id: 'evt1',
      summary: 'Team standup',
      start: '2026-05-20T09:00:00Z',
      end: '2026-05-20T09:30:00Z',
      description: 'Daily sync',
      location: 'Zoom',
      htmlLink: 'https://calendar.google.com/evt1',
    });
    expect(result.events[0].attendees).toHaveLength(2);
    expect(result.events[0].attendees![0]).toMatchObject({ email: 'alice@example.com', responseStatus: 'accepted' });
    // Second event has no description/location — they should be absent
    expect('description' in result.events[1]).toBe(false);
    expect('location' in result.events[1]).toBe(false);
  });

  it('maps all-day events (date only) to midnight-Z strings', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'allday1',
            summary: 'Conference',
            start: { date: '2026-05-22' },
            end: { date: '2026-05-23' },
            htmlLink: 'https://calendar.google.com/allday1',
          },
        ],
      },
    });

    const result = await calendarListEvents(CTX, {
      time_min: '2026-05-22T00:00:00Z',
      time_max: '2026-05-23T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].start).toBe('2026-05-22T00:00:00Z');
    expect(result.events[0].end).toBe('2026-05-23T00:00:00Z');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await calendarListEvents(CTX, {
      time_min: '2026-05-20T00:00:00Z',
      time_max: '2026-05-21T00:00:00Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });

  it('respects default and cap for max_results', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsListFn.mockResolvedValue({ data: { items: [] } });

    await calendarListEvents(CTX, { time_min: '2026-05-20T00:00:00Z', time_max: '2026-05-21T00:00:00Z' });
    expect(mockCalendarEventsListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 50 }));

    await calendarListEvents(CTX, {
      time_min: '2026-05-20T00:00:00Z',
      time_max: '2026-05-21T00:00:00Z',
      max_results: 500,
    });
    expect(mockCalendarEventsListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 250 }));
  });
});

describe('calendarCreateEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — returns eventId and htmlLink with principal', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({
      data: {
        id: 'new_evt_abc',
        htmlLink: 'https://calendar.google.com/new_evt_abc',
      },
    });

    const result = await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Project review',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventId).toBe('new_evt_abc');
    expect(result.htmlLink).toBe('https://calendar.google.com/new_evt_abc');
    expect(result.principal).toBe('self');
  });

  it('sends dateTime in requestBody for timed events', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({ data: { id: 'e1', htmlLink: '' } });

    await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Meeting',
    });

    const callArg = mockCalendarEventsInsertFn.mock.calls[0][0] as {
      requestBody: { start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } };
    };
    expect(callArg.requestBody.start.dateTime).toBe('2026-05-25T14:00:00Z');
    expect(callArg.requestBody.start.date).toBeUndefined();
    expect(callArg.requestBody.end.dateTime).toBe('2026-05-25T15:00:00Z');
    expect(callArg.requestBody.end.date).toBeUndefined();
  });

  it('sends date (not dateTime) in requestBody for all-day events', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({ data: { id: 'e2', htmlLink: '' } });

    await calendarCreateEvent(CTX, {
      start: '2026-05-25T00:00:00Z',
      end: '2026-05-26T00:00:00Z',
      summary: 'All-day event',
    });

    const callArg = mockCalendarEventsInsertFn.mock.calls[0][0] as {
      requestBody: { start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string } };
    };
    expect(callArg.requestBody.start.date).toBe('2026-05-25');
    expect(callArg.requestBody.start.dateTime).toBeUndefined();
    expect(callArg.requestBody.end.date).toBe('2026-05-26');
    expect(callArg.requestBody.end.dateTime).toBeUndefined();
  });

  it('accepts attendees as array of strings and normalizes to objects', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({ data: { id: 'e3', htmlLink: '' } });

    await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Meeting with strings',
      attendees: ['alice@example.com', 'bob@example.com'],
    });

    const callArg = mockCalendarEventsInsertFn.mock.calls[0][0] as {
      requestBody: { attendees?: Array<{ email: string }> };
    };
    expect(callArg.requestBody.attendees).toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]);
  });

  it('accepts attendees as array of objects', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({ data: { id: 'e4', htmlLink: '' } });

    await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Meeting with objects',
      attendees: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
    });

    const callArg = mockCalendarEventsInsertFn.mock.calls[0][0] as {
      requestBody: { attendees?: Array<{ email: string }> };
    };
    expect(callArg.requestBody.attendees).toEqual([{ email: 'alice@example.com' }, { email: 'bob@example.com' }]);
  });

  it('passes sendUpdates: "all" to notify attendees', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockCalendarEventsInsertFn.mockResolvedValue({ data: { id: 'e5', htmlLink: '' } });

    await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Notify test',
    });

    const callArg = mockCalendarEventsInsertFn.mock.calls[0][0] as { sendUpdates: string };
    expect(callArg.sendUpdates).toBe('all');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await calendarCreateEvent(CTX, {
      start: '2026-05-25T14:00:00Z',
      end: '2026-05-25T15:00:00Z',
      summary: 'Test',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });
});

describe('calendarFindFreeSlot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('correctly identifies a gap between two events', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    // Window: 09:00–17:00. Events: 09:00–10:00, 11:00–12:00.
    // Gaps: [10:00–11:00] (60 min), [12:00–17:00] (300 min).
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'e1',
            summary: 'Morning meeting',
            start: { dateTime: '2026-05-20T09:00:00Z' },
            end: { dateTime: '2026-05-20T10:00:00Z' },
          },
          {
            id: 'e2',
            summary: 'Lunch talk',
            start: { dateTime: '2026-05-20T11:00:00Z' },
            end: { dateTime: '2026-05-20T12:00:00Z' },
          },
        ],
      },
    });

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 30,
      time_min: '2026-05-20T09:00:00Z',
      time_max: '2026-05-20T17:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    // Should find at least two slots: [10:00–11:00] and [12:00–17:00]
    expect(result.slots.length).toBeGreaterThanOrEqual(2);
    expect(result.slots[0].start).toBe('2026-05-20T10:00:00.000Z');
    expect(result.slots[0].end).toBe('2026-05-20T11:00:00.000Z');
    expect(result.slots[1].start).toBe('2026-05-20T12:00:00.000Z');
    expect(result.slots[1].end).toBe('2026-05-20T17:00:00.000Z');
  });

  it('filters out gaps shorter than duration_minutes', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    // Window: 09:00–17:00. Events: 09:00–10:00, 10:15–17:00.
    // Gap: [10:00–10:15] = 15 min. If duration=60, this should be filtered.
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'e1',
            summary: 'Morning',
            start: { dateTime: '2026-05-20T09:00:00Z' },
            end: { dateTime: '2026-05-20T10:00:00Z' },
          },
          {
            id: 'e2',
            summary: 'Afternoon',
            start: { dateTime: '2026-05-20T10:15:00Z' },
            end: { dateTime: '2026-05-20T17:00:00Z' },
          },
        ],
      },
    });

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 60,
      time_min: '2026-05-20T09:00:00Z',
      time_max: '2026-05-20T17:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 15-minute gap is too short; no trailing gap either — should be empty
    expect(result.slots).toHaveLength(0);
  });

  it('skips transparent (free/unblocking) events', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    // Window: 09:00–17:00. Events: 09:00–10:00 (transparent = free), 11:00–12:00 (opaque).
    // The transparent event should be skipped; only [09:00–11:00] and [12:00–17:00] are gaps.
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'e1',
            summary: 'OOO (free)',
            transparency: 'transparent',
            start: { dateTime: '2026-05-20T09:00:00Z' },
            end: { dateTime: '2026-05-20T10:00:00Z' },
          },
          {
            id: 'e2',
            summary: 'Real meeting',
            start: { dateTime: '2026-05-20T11:00:00Z' },
            end: { dateTime: '2026-05-20T12:00:00Z' },
          },
        ],
      },
    });

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 30,
      time_min: '2026-05-20T09:00:00Z',
      time_max: '2026-05-20T17:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // transparent event ignored → gap at 09:00–11:00 surfaces first
    expect(result.slots[0].start).toBe('2026-05-20T09:00:00.000Z');
    expect(result.slots[0].end).toBe('2026-05-20T11:00:00.000Z');
  });

  it('all-day event blocks the entire day', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ tok: 'tok', principal: 'self' } as never);
    // Simulate mockResolvedValue properly
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    // Window: 2026-05-20 00:00Z–2026-05-20 23:59Z. All-day event on 2026-05-20.
    // After clamping to window, the all-day interval [00:00–00:00 next day] covers everything.
    mockCalendarEventsListFn.mockResolvedValue({
      data: {
        items: [
          {
            id: 'e_allday',
            summary: 'Holiday',
            start: { date: '2026-05-20' },
            end: { date: '2026-05-21' },
          },
        ],
      },
    });

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 30,
      time_min: '2026-05-20T00:00:00Z',
      time_max: '2026-05-20T23:59:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All-day event covers the whole window → no free slots
    expect(result.slots).toHaveLength(0);
  });

  it('respects max_slots cap', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    // No events → entire window is one gap, but max_slots=1 means only one slot returned
    mockCalendarEventsListFn.mockResolvedValue({ data: { items: [] } });

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 30,
      time_min: '2026-05-20T09:00:00Z',
      time_max: '2026-05-20T17:00:00Z',
      max_slots: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toHaveLength(1);
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await calendarFindFreeSlot(CTX, {
      duration_minutes: 60,
      time_min: '2026-05-20T09:00:00Z',
      time_max: '2026-05-20T17:00:00Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });
});
