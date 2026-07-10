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
  { method: 'PUT', path: '/api/drafts/user_bob/knowledge/benchmarks/b1', body: {} },
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
  it('PUT /api/drafts/user_alice/persona → not 403', async () => {
    const { req, res, getStatus } = fakeReqRes('PUT', { text: 'my persona' });
    const url = new URL('/api/drafts/user_alice/persona', 'http://localhost');
    await route(req, res, url, 'PUT', aliceSession());
    expect(getStatus()).not.toBe(403);
  });
});
