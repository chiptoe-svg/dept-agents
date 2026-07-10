/**
 * Route-level tests for POST /api/direct-chat (task-8, plan 1.5 — fixes H1/H2).
 *
 * Two independent holes existed: `agentFolder` was optional (skipping
 * authorization entirely when omitted), and neither the model allowlist nor
 * the cost budget was ever enforced. These tests drive the real `route()`
 * dispatcher (not just the pure helpers) so a regression that re-opens the
 * route-level gate — even while `assertWithinBudget`/`requireGroupAccess`
 * keep working correctly in isolation — is caught.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-direct-chat',
    GROUPS_DIR: '/tmp/nanoclaw-test-direct-chat/groups',
    PLAYGROUND_AUTH_BYPASS: false,
  };
});

// Isolate route-wiring tests from assertWithinBudget's own logic (already
// unit-tested in src/modules/budgets/enforce.test.ts) — controllable here
// per test via mockReturnValue.
vi.mock('../../modules/budgets/enforce.js', () => ({
  assertWithinBudget: vi.fn(() => ({ ok: true })),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { assertWithinBudget } from '../../modules/budgets/enforce.js';
import { route } from './api-routes.js';
import type { PlaygroundSession } from './auth-store.js';

const assertWithinBudgetMock = vi.mocked(assertWithinBudget);

const TMP = '/tmp/nanoclaw-test-direct-chat';
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

  // ag_alice's allowlist permits only claude-good. Model-allowlist checks
  // are keyed by catalog `modelProvider` names (anthropic/openai-codex/...
  // — see migration 022), and the frontend's `provider` field for the
  // 'Anthropic' group happens to coincide with that name, so 'anthropic' is
  // used directly in test request bodies.
  ensureContainerConfig('ag_alice');
  updateContainerConfigJson('ag_alice', 'allowed_models', [{ provider: 'anthropic', model: 'claude-good' }]);
  ensureContainerConfig('ag_bob');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  seed();
  assertWithinBudgetMock.mockReset().mockReturnValue({ ok: true });

  // Stub the network boundary dispatchAnthropic() calls through — no real
  // LLM API calls in tests. Anthropic /v1/messages response shape.
  fetchMock = vi.fn(async () =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function aliceSession(): PlaygroundSession {
  return { cookieValue: 'c', userId: 'playground:alice', createdAt: Date.now(), lastActivityAt: Date.now() };
}

/** Minimal req/res doubles: we assert only on the status code + body. */
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
  await route(req, res, url, 'POST', aliceSession());
  return { status: getStatus(), body: getBody() };
}

const baseBody = {
  provider: 'anthropic',
  model: 'claude-good',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('POST /api/direct-chat', () => {
  it('with no agentFolder → 400', async () => {
    const { status } = await postDirectChat({ ...baseBody });
    expect(status).toBe(400);
  });

  it("with another user's agentFolder → 403", async () => {
    const { status } = await postDirectChat({ ...baseBody, agentFolder: 'user_bob' });
    expect(status).toBe(403);
  });

  it('with an over-budget group → 429', async () => {
    assertWithinBudgetMock.mockReturnValue({ ok: false, reason: 'Monthly budget exceeded ($99.00 of $10.00).' });
    const { status } = await postDirectChat({ ...baseBody, agentFolder: 'user_alice' });
    expect(status).toBe(429);
  });

  it('with a model not on the allowlist → rejected (403)', async () => {
    const { status, body } = await postDirectChat({
      ...baseBody,
      model: 'claude-not-allowed',
      agentFolder: 'user_alice',
    });
    expect(status).toBe(403);
    expect((body as { error: string }).error).toMatch(/allowlist/i);
  });

  it('own group, under budget, allowed model → not 400/403/429', async () => {
    const { status } = await postDirectChat({ ...baseBody, agentFolder: 'user_alice' });
    expect(status).not.toBe(400);
    expect(status).not.toBe(403);
    expect(status).not.toBe(429);
    expect(status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });
});
