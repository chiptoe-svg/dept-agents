/**
 * Route-level tests for POST /api/drafts/:folder/messages attachment
 * handling (task-1, A3 member-chat plan). The handler's per-file loop has
 * three branches: image/* → inline vision, application/pdf → attachments/ +
 * [PDF: …] marker (both pre-existing, unchanged), and — the new behavior
 * under test here — any other allowlisted work file → attachments/ + a
 * [File: …] marker, with off-allowlist files (executables etc.) rejected.
 *
 * Drives the real `route()` dispatcher so a regression in the allowlist
 * wiring inside api-routes.ts (not just in the pure `isAllowedAttachment`
 * predicate, already covered by attachment-allowlist.test.ts) is caught.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-attach',
    GROUPS_DIR: '/tmp/nanoclaw-test-attach/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

// The messages route reaches out to the channel adapter's onInboundEvent to
// forward the composed message into the router. That's unrelated machinery
// (routing, session wake) — stub it so this test observes only what the
// route itself decides: what got written to disk and what content/errors it
// reports back in the HTTP response.
const onInboundEvent = vi.fn();
vi.mock('./adapter.js', async () => {
  const actual = await vi.importActual<typeof import('./adapter.js')>('./adapter.js');
  return {
    ...actual,
    getSetupConfig: () => ({
      onInbound: vi.fn(),
      onInboundEvent,
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    }),
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';
import type { InboundEvent } from '../adapter.js';

const TMP = '/tmp/nanoclaw-test-attach';
const GROUPS = path.join(TMP, 'groups');
const NOW = '2026-07-09T00:00:00Z';
const FOLDER = 'user_alice';

function seed(): void {
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({
    id: 'ag_alice',
    name: 'Alice',
    folder: FOLDER,
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, FOLDER), { recursive: true });
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
  onInboundEvent.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function aliceSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:alice', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: we assert on the status code + JSON body. */
function fakeReqRes(method: string, body: unknown) {
  const req = Object.assign(new http.IncomingMessage(null as never), { method });
  req.push(body === undefined ? null : JSON.stringify(body));
  req.push(null);
  let status = 0;
  let responseBody: unknown;
  const res = {
    statusCode: 0,
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') {
        try {
          responseBody = JSON.parse(chunk);
        } catch {
          responseBody = chunk;
        }
      }
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as http.ServerResponse;
  return {
    req,
    res,
    getStatus: () => status || (res as { statusCode: number }).statusCode,
    getBody: () => responseBody as { ok?: boolean; messageId?: string; attachmentErrors?: string[] },
  };
}

async function postMessage(body: unknown) {
  const { req, res, getStatus, getBody } = fakeReqRes('POST', body);
  const url = new URL(`/api/drafts/${FOLDER}/messages`, 'http://localhost');
  await route(req, res, url, 'POST', aliceSession());
  return { status: getStatus(), body: getBody() };
}

function lastEvent(): InboundEvent {
  expect(onInboundEvent).toHaveBeenCalledTimes(1);
  return onInboundEvent.mock.calls[0]![0] as InboundEvent;
}

function composedText(): string {
  const content = JSON.parse(lastEvent().message.content) as { text: string };
  return content.text;
}

const attachDir = path.join(GROUPS, FOLDER, 'attachments');

describe('POST /api/drafts/:folder/messages — attachment allowlist', () => {
  it('an allowlisted non-image file (.csv) is saved and referenced with a [File: …] marker', async () => {
    const base64 = Buffer.from('a,b,c\n1,2,3\n').toString('base64');
    const { status, body } = await postMessage({
      text: 'here is the data',
      files: [{ name: 'report.csv', mimeType: 'text/csv', base64 }],
    });

    expect(status).toBe(200);
    expect(body.attachmentErrors).toBeUndefined();

    const saved = fs.readdirSync(attachDir);
    expect(saved).toEqual(['report.csv']);
    expect(fs.readFileSync(path.join(attachDir, 'report.csv'), 'utf8')).toBe('a,b,c\n1,2,3\n');

    expect(composedText()).toContain('[File: attachments/report.csv]');
  });

  it('an off-allowlist file (.exe) is rejected — nothing written, error reported', async () => {
    const base64 = Buffer.from('MZ...').toString('base64');
    const { status, body } = await postMessage({
      text: 'run this',
      files: [{ name: 'evil.exe', mimeType: 'application/octet-stream', base64 }],
    });

    expect(status).toBe(200);
    expect(fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : []).toEqual([]);
    expect(body.attachmentErrors).toBeDefined();
    expect(body.attachmentErrors!.some((e) => /blocked file type/.test(e))).toBe(true);

    expect(composedText()).not.toContain('[File:');
  });

  it('an image/png still takes the inline vision path — no [File: …] marker, images[] populated', async () => {
    // Tiny 1x1 PNG.
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const { status, body } = await postMessage({
      text: 'a picture',
      files: [{ name: 'photo.png', mimeType: 'image/png', base64: pngBase64 }],
    });

    expect(status).toBe(200);
    expect(body.attachmentErrors).toBeUndefined();

    const content = JSON.parse(lastEvent().message.content) as { text: string; images?: unknown[] };
    expect(content.text).not.toContain('[File:');
    expect(content.images).toBeDefined();
    expect(content.images!.length).toBe(1);

    // No non-image attachment was persisted under attachments/ for this file
    // (processImage() writes its own resized .jpg there, which is expected —
    // just confirm no [File: …]-marker file exists).
    expect(fs.existsSync(attachDir) ? fs.readdirSync(attachDir) : []).not.toContain('photo.png');
  });
});
