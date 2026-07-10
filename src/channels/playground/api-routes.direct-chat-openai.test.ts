/**
 * Route-level tests pinning the real OpenAI cost-attribution + budget path
 * for POST /api/direct-chat (task-1p5-8 review, Fix 1).
 *
 * Deliberately does NOT mock `modules/budgets/enforce.js`, `usage.js`, or
 * `cost-budgets.js` (unlike api-routes.direct-chat.test.ts) — the whole
 * point is to exercise the real `assertWithinBudget` → `aggregateAgentUsage`
 * → catalog-price chain against a real (test-scoped) outbound.db row, so a
 * regression that re-breaks cost *attribution* (as opposed to route wiring)
 * is caught. Before the fix: `direct-chat.ts` priced OpenAI turns at
 * `costUsd: 0` and persisted `provider: 'openai'` (unresolved), so spend
 * never accumulated and the budget check could never trip. Both assertions
 * below fail against the pre-fix code and pass after.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    PROJECT_ROOT: '/tmp/nanoclaw-test-direct-chat-openai',
    DATA_DIR: '/tmp/nanoclaw-test-direct-chat-openai/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-direct-chat-openai/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { writeCostBudgets } from './api/cost-budgets.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';

const PROJECT_ROOT = '/tmp/nanoclaw-test-direct-chat-openai';
const GROUPS = path.join(PROJECT_ROOT, 'groups');
const NOW = '2026-07-09T00:00:00Z';

function seed(): void {
  createUser({ id: 'playground:dana', kind: 'playground', display_name: 'Dana', created_at: NOW });
  createAgentGroup({
    id: 'ag_dana',
    name: 'Dana',
    folder: 'user_dana',
    agent_provider: 'pi',
    created_at: NOW,
    metadata: '{}',
  });
  addMember({ user_id: 'playground:dana', agent_group_id: 'ag_dana', added_by: null, added_at: NOW });
  fs.mkdirSync(path.join(GROUPS, 'user_dana'), { recursive: true });
  // Unrestricted allowlist — this test is about cost attribution + budget,
  // not the allowlist (already covered by api-routes.direct-chat.test.ts).
  ensureContainerConfig('ag_dana');
  // Tiny budget: the tokens the fetch stub below returns price to $0.01 for
  // gpt-5.4 (real catalog rates: $0.0025/1k in + $0.015/1k out), which must
  // exceed this to trip 'over' on the second call.
  writeCostBudgets({ defaultMonthlyUsd: 0.005, warnFraction: 0.8, perAgent: {} });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();

  // Stub the network boundary — OpenAI Chat Completions response shape (the
  // wire format /openai/v1 dispatch parses). 1000 prompt + 500 completion
  // tokens → $0.0025 + $0.0075 = $0.01 at gpt-5.4's real catalog rates.
  fetchMock = vi.fn(async () =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
      text: async () => '',
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  fs.rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

function danaSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:dana', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: mirrors api-routes.direct-chat.test.ts. */
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
    getBody: () => responseBody,
  };
}

async function postDirectChat(body: unknown) {
  const { req, res, getStatus, getBody } = fakeReqRes('POST', body);
  const url = new URL('/api/direct-chat', 'http://localhost');
  await route(req, res, url, 'POST', danaSession());
  return { status: getStatus(), body: getBody() };
}

/** Reads the (single) recorded direct-chat row's `provider` column, mirroring
 *  how direct-chat.ts's recordDirectChatUsage lays out the pseudo session. */
function readPersistedProvider(agentGroupId: string): string | null {
  const outboundPath = path.join(sessionsBaseDir(), agentGroupId, 'direct-chat', 'outbound.db');
  const db = new Database(outboundPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT provider FROM messages_out ORDER BY rowid DESC LIMIT 1`).get() as
      | { provider: string | null }
      | undefined;
    return row?.provider ?? null;
  } finally {
    db.close();
  }
}

const openaiBody = {
  provider: 'openai',
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hi' }],
  agentFolder: 'user_dana',
};

describe('POST /api/direct-chat — OpenAI cost attribution + budget (real path, no mocks)', () => {
  it('prices an OpenAI turn > $0 and persists the resolved catalog provider, not the raw group id', async () => {
    const { status, body } = await postDirectChat(openaiBody);
    expect(status).toBe(200);
    expect((body as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect(readPersistedProvider('ag_dana')).toBe('openai-codex');
  });

  it('an over-budget OpenAI group gets 429 on the next turn', async () => {
    // First turn: pushes real recorded spend to $0.01, over the $0.005 budget.
    const first = await postDirectChat(openaiBody);
    expect(first.status).toBe(200);

    // Second turn: assertWithinBudget (real, unmocked) now sees $0.01 of
    // accumulated spend against a $0.005 budget via the real
    // aggregateAgentUsage → catalog price lookup.
    const second = await postDirectChat(openaiBody);
    expect(second.status).toBe(429);
    expect((second.body as { error: string }).error).toMatch(/budget/i);
  });
});
