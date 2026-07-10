/**
 * Route-level budget tests for the knowledge/RAG routes that spend on
 * embeddings (task-p2-9, Step 5): corpus ingest, corpus query, and
 * benchmark run. All three were authorization-gated to the caller's own
 * group already (so no cross-tenant isolation hole), but had no cost cap —
 * an over-budget group could still trigger unbounded embedding spend.
 * Mirrors api-routes.direct-chat.test.ts's pattern: drive the real route()
 * dispatcher with assertWithinBudget mocked so these tests aren't
 * re-verifying assertWithinBudget's own logic (already covered by
 * src/modules/budgets/enforce.test.ts), only that each route actually calls
 * it and honors a 429.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-knowledge-budget',
    GROUPS_DIR: '/tmp/nanoclaw-test-knowledge-budget/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

vi.mock('../../modules/budgets/enforce.js', () => ({
  assertWithinBudget: vi.fn(() => ({ ok: true })),
}));

// storeStrategy: 'bm25' keeps handleQuery/handleRunBenchmark off the
// embedding path in the "under budget" happy-path assertions below — the
// budget gate must still fire before any of that runs, but these tests
// aren't exercising embedChunks itself (that's stages/embed.test.ts).

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { assertWithinBudget } from '../../modules/budgets/enforce.js';
import { createCorpus } from '../../knowledge/corpus.js';
import { createBenchmark } from '../../knowledge/benchmarks/store.js';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';

const assertWithinBudgetMock = vi.mocked(assertWithinBudget);

const TMP = '/tmp/nanoclaw-test-knowledge-budget';
const GROUPS = path.join(TMP, 'groups');
const NOW = '2026-07-09T00:00:00Z';
const OVER_BUDGET = { ok: false as const, reason: 'Monthly budget exceeded ($99.00 of $10.00).' };

function seed(): void {
  createUser({ id: 'playground:alice', kind: 'playground', display_name: 'Alice', created_at: NOW });
  createAgentGroup({
    id: 'ag_alice',
    name: 'Alice',
    folder: 'user_alice',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:alice', agent_group_id: 'ag_alice', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, 'user_alice'), { recursive: true });
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
  assertWithinBudgetMock.mockReset().mockReturnValue({ ok: true });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function aliceSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:alice', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: we assert only on the status code. */
function fakeReqRes(method: string, body: unknown) {
  const req = Object.assign(new http.IncomingMessage(null as never), { method });
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

async function request(method: string, urlPath: string, body?: unknown) {
  const { req, res, getStatus } = fakeReqRes(method, body);
  const url = new URL(urlPath, 'http://localhost');
  await route(req, res, url, method, aliceSession());
  return getStatus();
}

describe('POST .../knowledge/corpora/:id/ingest — budget gate', () => {
  it('over-budget group → 429, before assertWithinBudget was wired this reached handleIngest unconditionally', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text' });
    assertWithinBudgetMock.mockReturnValue(OVER_BUDGET);

    const status = await request('POST', `/api/drafts/user_alice/knowledge/corpora/${corpus.id}/ingest`, {});

    expect(status).toBe(429);
    expect(assertWithinBudgetMock).toHaveBeenCalledWith('user_alice', 'ag_alice');
  });

  it('under budget → not 429 (falls through to the handler)', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text' });

    const status = await request('POST', `/api/drafts/user_alice/knowledge/corpora/${corpus.id}/ingest`, {});

    expect(status).not.toBe(429);
    expect(status).toBe(202);
  });
});

describe('POST .../knowledge/corpora/:id/query — budget gate', () => {
  it('over-budget group → 429, before assertWithinBudget was wired this reached handleQuery unconditionally', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text', storeStrategy: 'bm25' });
    assertWithinBudgetMock.mockReturnValue(OVER_BUDGET);

    const status = await request('POST', `/api/drafts/user_alice/knowledge/corpora/${corpus.id}/query`, {
      query: 'hello',
    });

    expect(status).toBe(429);
    expect(assertWithinBudgetMock).toHaveBeenCalledWith('user_alice', 'ag_alice');
  });

  it('under budget → not 429 (falls through to the handler)', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text', storeStrategy: 'bm25' });

    const status = await request('POST', `/api/drafts/user_alice/knowledge/corpora/${corpus.id}/query`, {
      query: 'hello',
    });

    expect(status).not.toBe(429);
    expect(status).toBe(200);
  });

  it('unknown group (no agent_groups row) → budget check is skipped, not a 500', async () => {
    // canReadDraft falls through OPEN for a folder with no agent_groups row;
    // getAgentGroupByFolder returns null there, so the route must not crash
    // trying to read `.id` off a null group.
    const status = await request('POST', '/api/drafts/user_nonexistent/knowledge/corpora/c1/query', {
      query: 'hello',
    });

    expect(assertWithinBudgetMock).not.toHaveBeenCalled();
    expect(status).toBe(404); // handleQuery: corpus dir doesn't exist
  });
});

describe('POST .../knowledge/benchmarks/:id/run — budget gate', () => {
  it('over-budget group → 429, before assertWithinBudget was wired this reached handleRunBenchmark unconditionally', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text', storeStrategy: 'bm25' });
    const bench = createBenchmark('user_alice', { name: 'b', corpusId: corpus.id });
    assertWithinBudgetMock.mockReturnValue(OVER_BUDGET);

    const status = await request('POST', `/api/drafts/user_alice/knowledge/benchmarks/${bench.id}/run`, {});

    expect(status).toBe(429);
    expect(assertWithinBudgetMock).toHaveBeenCalledWith('user_alice', 'ag_alice');
  });

  it('under budget → not 429 (falls through to the handler)', async () => {
    const corpus = createCorpus('user_alice', { name: 'c', sourceType: 'text', storeStrategy: 'bm25' });
    const bench = createBenchmark('user_alice', { name: 'b', corpusId: corpus.id });

    const status = await request('POST', `/api/drafts/user_alice/knowledge/benchmarks/${bench.id}/run`, {});

    expect(status).not.toBe(429);
    expect(status).toBe(200);
  });
});
