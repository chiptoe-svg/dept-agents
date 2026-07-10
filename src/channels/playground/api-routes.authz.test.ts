import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-authz',
    GROUPS_DIR: '/tmp/nanoclaw-test-authz/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { requireGroupAccess } from './require-group-access.js';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';

const TMP = '/tmp/nanoclaw-test-authz';
const GROUPS = path.join(TMP, 'groups');
const NOW = '2026-07-09T00:00:00Z';

function seed(): void {
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createUser({ id: 'playground:bob', kind: 'playground', display_name: 'Bob', created_at: NOW });
  createAgentGroup({
    id: 'ag_alice',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  createAgentGroup({
    id: 'ag_bob',
    name: 'Bob',
    folder: 'user_bob',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  addMember({ user_id: 'playground:bob', agent_group_id: 'ag_bob', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, 'user_alice'), { recursive: true });
  fs.mkdirSync(path.join(GROUPS, 'user_bob'), { recursive: true });
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('requireGroupAccess', () => {
  it('allows a member on their own group', () => {
    expect(requireGroupAccess('user_alice', 'playground:alice')).toBeNull();
  });

  it('denies a member on another user group', () => {
    expect(requireGroupAccess('user_bob', 'playground:alice')).toBe('not_member');
  });

  it('denies an anonymous caller', () => {
    expect(requireGroupAccess('user_alice', null)).toBe('no_session');
  });

  it('fails closed on an unknown folder', () => {
    expect(requireGroupAccess('user_nonexistent', 'playground:alice')).toBe('unknown_group');
  });
});

function aliceSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:alice', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: we assert only on the status code. */
function fakeReqRes(method: string, body: unknown) {
  const req = Object.assign(new http.IncomingMessage(null as never), { method });
  // readJsonBody() reads the stream; push the body then EOF.
  req.push(body === undefined ? null : JSON.stringify(body));
  req.push(null);
  let status = 0;
  const res = {
    statusCode: 0,
    writeHead(s: number) {
      status = s;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as http.ServerResponse;
  return { req, res, getStatus: () => status || (res as { statusCode: number }).statusCode };
}

/** Every folder-addressed MUTATION route. Add a row here when you add a route. */
const MUTATION_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/drafts', body: { targetFolder: 'user_bob' } },
  { method: 'DELETE', path: '/api/drafts/draft_user_bob' },
  { method: 'POST', path: '/api/drafts/draft_user_bob/apply' },
  { method: 'POST', path: '/api/drafts/user_bob/messages', body: { text: 'pwn' } },
  { method: 'PUT', path: '/api/drafts/user_bob/persona', body: { text: 'pwn' } },
  { method: 'PUT', path: '/api/drafts/user_bob/skills', body: { skills: [] } },
  { method: 'PUT', path: '/api/drafts/user_bob/custom-skills/s/file', body: { name: 'a', text: 'x' } },
  { method: 'DELETE', path: '/api/drafts/user_bob/custom-skills/s' },
  { method: 'PUT', path: '/api/drafts/user_bob/models', body: { models: [] } },
  { method: 'PUT', path: '/api/drafts/user_bob/active-model', body: { model: 'x' } },
  { method: 'PUT', path: '/api/drafts/user_bob/name', body: { name: 'x' } },
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/corpora', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/drafts/user_bob/knowledge/corpora/c1' },
  { method: 'PUT', path: '/api/drafts/user_bob/knowledge/corpora/c1/upload', body: {} },
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/corpora/c1/ingest', body: {} },
  // NOTE: this row 403s via canReadDraft (checked ahead of requireGroupAccess
  // in the PUT branch), not via the requireGroupAccess gate added for this
  // route — see the dedicated 'requireGroupAccess is the operative gate on
  // benchmarks/:id' test below, which isolates requireGroupAccess with an
  // unknown folder that canReadDraft would fail OPEN on.
  { method: 'PUT', path: '/api/drafts/user_bob/knowledge/benchmarks/b1', body: {} },
  // Fix 1 (CRITICAL, task-1p5-2): body-folder routes, previously fully ungated.
  { method: 'POST', path: '/api/simple-restart', body: { folder: 'user_bob' } },
  { method: 'POST', path: '/api/simple-reset', body: { folder: 'user_bob' } },
  // Fix 2: previously gated only by canReadDraft (fails open on unknown
  // folder, honors PLAYGROUND_AUTH_BYPASS) — upgraded to requireGroupAccess.
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/benchmarks', body: { name: 'x', corpusId: 'c1' } },
  { method: 'POST', path: '/api/drafts/user_bob/knowledge/benchmarks/b1/run', body: {} },
  { method: 'POST', path: '/api/drafts/user_bob/library', body: { name: 'x' } },
  {
    method: 'POST',
    path: '/api/drafts/user_bob/library/from-template',
    body: { templateSlug: 't', name: 'x' },
  },
  { method: 'POST', path: '/api/drafts/user_bob/library/s1/save', body: {} },
  { method: 'POST', path: '/api/drafts/user_bob/library/s1/load' },
  { method: 'PUT', path: '/api/drafts/user_bob/library/s1', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/drafts/user_bob/library/s1' },
];

describe('cross-tenant mutation routes are denied', () => {
  for (const r of MUTATION_ROUTES) {
    it(`${r.method} ${r.path} → 403 for a non-member`, async () => {
      const { req, res, getStatus } = fakeReqRes(r.method, r.body);
      const url = new URL(r.path, 'http://localhost');
      await route(req, res, url, r.method, aliceSession());
      expect(getStatus()).toBe(403);
    });
  }
});

describe('own-group mutation still works', () => {
  // One own-group positive case per gate *shape* — a route that 403s
  // unconditionally would still pass every cross-tenant case above, so
  // these are what actually prove the gate discriminates alice-on-alice
  // from alice-on-bob rather than just denying everyone.

  // Shape 1: raw URL folder (folder read straight from the path segment).
  it('PUT /api/drafts/user_alice/persona → not 403', async () => {
    const { req, res, getStatus } = fakeReqRes('PUT', { text: 'my persona' });
    const url = new URL('/api/drafts/user_alice/persona', 'http://localhost');
    await route(req, res, url, 'PUT', aliceSession());
    expect(getStatus()).not.toBe(403);
  });

  // Shape 2: body folder/targetFolder (folder read from the JSON body, not
  // the URL) — this is the shape Fix 1 gated (simple-restart/simple-reset).
  it('POST /api/simple-restart (own folder) → 200', async () => {
    const { req, res, getStatus } = fakeReqRes('POST', { folder: 'user_alice' });
    const url = new URL('/api/simple-restart', 'http://localhost');
    await route(req, res, url, 'POST', aliceSession());
    expect(getStatus()).toBe(200);
  });

  // Shape 3: "stripped draft_" family — the create-draft route also takes
  // its target from the body (`targetFolder`), same as shape 2 in the code
  // path sense, but it is the entry point for the draft_-prefixed routes
  // (DELETE/apply) that strip the `draft_` prefix back to this target
  // folder before gating. Exercised here per the review brief; the actual
  // prefix-stripping code (api-routes.ts's `draftFolder.slice('draft_'.length)`)
  // is covered by the DELETE/apply cross-tenant cases in MUTATION_ROUTES
  // above, which would 200/400 instead of 403 if the strip were wrong.
  it('POST /api/drafts (targetFolder: own folder) → not 403', async () => {
    const { req, res, getStatus } = fakeReqRes('POST', { targetFolder: 'user_alice' });
    const url = new URL('/api/drafts', 'http://localhost');
    await route(req, res, url, 'POST', aliceSession());
    expect(getStatus()).not.toBe(403);
  });
});

describe('requireGroupAccess is the operative gate on benchmarks/:id', () => {
  // The benchmarks/:id row in MUTATION_ROUTES 403s via canReadDraft (checked
  // first in that route's shared prelude), which would pass even if
  // requireGroupAccess were deleted from the PUT/DELETE branches entirely.
  // Isolate requireGroupAccess with a folder canReadDraft fails OPEN on
  // (no agent_groups row) — only requireGroupAccess's fail-closed
  // unknown-folder behavior can deny this one.
  it('PUT .../knowledge/benchmarks/:id on an unknown folder → 403 via requireGroupAccess', async () => {
    const { req, res, getStatus } = fakeReqRes('PUT', {});
    const url = new URL('/api/drafts/user_nonexistent/knowledge/benchmarks/b1', 'http://localhost');
    await route(req, res, url, 'PUT', aliceSession());
    expect(getStatus()).toBe(403);
  });
});
