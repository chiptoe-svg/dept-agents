# Proxy Payload Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every LLM request body that flows through `src/credential-proxy.ts` to a per-session SQLite store, exposed via a small host endpoint, so the Chat trace/context panel (next spec) can render the actual prompt that was sent for each turn.

**Architecture:** The credential-proxy already buffers every request body before forwarding upstream; this plan adds a sole-writer per-session SQLite file at `data/proxy-payloads/<agent-group>/<session-id>.db` populated by the proxy, plus a read-only host endpoint that parses captured bodies into per-section sizes on demand. Container injects a new `X-NanoClaw-Session-Id` header alongside the existing `X-NanoClaw-Agent-Group` so the proxy can attribute each capture.

**Tech Stack:** Node host (TypeScript + vitest + `better-sqlite3`), credential-proxy (`src/credential-proxy.ts`), Bun container-runner (`container/agent-runner/src/proxy-fetch.ts`), playground HTTP API (`src/channels/playground/api/`).

**Spec:** [`docs/superpowers/specs/2026-05-27-proxy-payload-log-design.md`](../specs/2026-05-27-proxy-payload-log-design.md)

---

## File Structure

New files:

| Path | Responsibility |
|---|---|
| `src/proxy-payload-log/store.ts` | Open / write / patch / read / retention-prune on a per-session SQLite file. Pure storage; no HTTP knowledge. |
| `src/proxy-payload-log/store.test.ts` | vitest unit tests for the storage layer. |
| `src/proxy-payload-log/sections.ts` | Pure parser: captured request body → `Sections` shape. Branch by `upstream_route`. |
| `src/proxy-payload-log/sections.test.ts` | Fixture-based unit tests for each provider's request schema. |
| `src/channels/playground/api/payloads.ts` | `GET /api/sessions/:id/payloads` handler. Auth-gated; reads from store; parses on demand. |
| `src/channels/playground/api/payloads.test.ts` | Handler tests. |

Modified files:

| Path | Change |
|---|---|
| `src/credential-proxy.ts` | After `body = Buffer.concat(chunks)`: await `store.write({...})`. In upstream `'end'` handler: dispatch `store.patch(seq, {response_status})`. Read new `X-NanoClaw-Session-Id` header. |
| `src/credential-proxy.test.ts` | Extend with payload-log integration tests. |
| `src/container-runner.ts` | `buildContainerArgs` sets new `X_NANOCLAW_SESSION_ID` env var alongside `X_NANOCLAW_AGENT_GROUP`. |
| `container/agent-runner/src/proxy-fetch.ts` | Propagate `X-NanoClaw-Session-Id` header from new env var, same pattern as existing agent-group header. |
| `container/agent-runner/src/proxy-fetch.test.ts` | Add session-header propagation test. |
| `src/channels/playground/api-routes.ts` | Register the new `GET /api/sessions/:id/payloads` route. |

**Session attribution fallback:** when `X-NanoClaw-Session-Id` is missing (older container or unattributed request), the store writes to `data/proxy-payloads/<agent-group>/unattributed.db`. No central-DB lookup needed — simpler than the spec's "most recent session" wording and equivalent for the trace-panel use case (the panel queries by known session-id so unattributed rows just don't surface).

---

## Task 1: Storage layer (`store.ts`)

**Files:**
- Create: `src/proxy-payload-log/store.ts`
- Create: `src/proxy-payload-log/store.test.ts`

- [ ] **Step 1: Write the failing test (open + write + read)**

Create `src/proxy-payload-log/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openStore, type PayloadStore } from './store.js';

describe('payload-store', () => {
  let tmpDir: string;
  let store: PayloadStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-store-'));
    store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a row and returns an incrementing seq', () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude', messages: [] }));
    const seq1 = store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    const seq2 = store.write({ ts: 1001, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });

  it('reads back rows in seq order', () => {
    const body = Buffer.from('{"x":1}');
    store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.write({ ts: 1001, upstreamRoute: 'openai', upstreamPath: '/v1/chat/completions', body });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows).toHaveLength(2);
    expect(rows[0].upstreamRoute).toBe('anthropic');
    expect(rows[1].upstreamRoute).toBe('openai');
  });

  it('creates the directory on first write', () => {
    const body = Buffer.from('{}');
    store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    expect(fs.existsSync(path.join(tmpDir, 'ag1', 'sess1.db'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/proxy-payload-log/store.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `store.ts` (write + read)**

Create `src/proxy-payload-log/store.ts`:

```typescript
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payloads (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  upstream_route  TEXT NOT NULL,
  upstream_path   TEXT NOT NULL,
  request_body    BLOB NOT NULL,
  request_bytes   INTEGER NOT NULL,
  truncated       INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  sections_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_payloads_ts ON payloads(ts);
`;

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB hard cap (spec § Error handling)
const RETAIN_ROWS = 50;                  // spec § Retention

export interface PayloadRow {
  seq: number;
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  requestBody: Buffer;
  requestBytes: number;
  truncated: boolean;
  responseStatus: number | null;
  sectionsJson: string | null;
}

export interface WriteInput {
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  body: Buffer;
}

export interface PayloadStore {
  write(input: WriteInput): number;
  patch(seq: number, fields: { responseStatus?: number; sectionsJson?: string }): void;
  list(opts: { limit: number; afterSeq: number }): PayloadRow[];
  close(): void;
}

export interface OpenOpts {
  baseDir: string;
  agentGroupId: string;
  sessionId: string; // 'unattributed' if header missing
}

export function openStore(opts: OpenOpts): PayloadStore {
  const dir = path.join(opts.baseDir, opts.agentGroupId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${opts.sessionId}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    'INSERT INTO payloads (ts, upstream_route, upstream_path, request_body, request_bytes, truncated) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const pruneStmt = db.prepare('DELETE FROM payloads WHERE seq <= (SELECT MAX(seq) - ? FROM payloads)');
  const listStmt = db.prepare(
    'SELECT seq, ts, upstream_route, upstream_path, request_body, request_bytes, truncated, response_status, sections_json FROM payloads WHERE seq > ? ORDER BY seq ASC LIMIT ?',
  );
  const patchStatus = db.prepare('UPDATE payloads SET response_status = ? WHERE seq = ?');
  const patchSections = db.prepare('UPDATE payloads SET sections_json = ? WHERE seq = ?');

  return {
    write(input) {
      const originalLen = input.body.length;
      const truncated = originalLen > MAX_BODY_BYTES ? 1 : 0;
      const body = truncated ? input.body.subarray(0, MAX_BODY_BYTES) : input.body;
      const info = insertStmt.run(input.ts, input.upstreamRoute, input.upstreamPath, body, originalLen, truncated);
      pruneStmt.run(RETAIN_ROWS);
      return Number(info.lastInsertRowid);
    },
    patch(seq, fields) {
      if (fields.responseStatus !== undefined) patchStatus.run(fields.responseStatus, seq);
      if (fields.sectionsJson !== undefined) patchSections.run(fields.sectionsJson, seq);
    },
    list(opts) {
      const rows = listStmt.all(opts.afterSeq, opts.limit) as Array<{
        seq: number;
        ts: number;
        upstream_route: string;
        upstream_path: string;
        request_body: Buffer;
        request_bytes: number;
        truncated: number;
        response_status: number | null;
        sections_json: string | null;
      }>;
      return rows.map((r) => ({
        seq: r.seq,
        ts: r.ts,
        upstreamRoute: r.upstream_route,
        upstreamPath: r.upstream_path,
        requestBody: r.request_body,
        requestBytes: r.request_bytes,
        truncated: r.truncated === 1,
        responseStatus: r.response_status,
        sectionsJson: r.sections_json,
      }));
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/proxy-payload-log/store.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Add the patch + retention + truncation tests**

Append to `src/proxy-payload-log/store.test.ts`:

```typescript
describe('payload-store patch + retention + truncation', () => {
  let tmpDir: string;
  let store: PayloadStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-store-'));
    store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('patches response_status on a written row', () => {
    const seq = store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: Buffer.from('{}') });
    store.patch(seq, { responseStatus: 200 });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows[0].responseStatus).toBe(200);
  });

  it('patches sections_json on a written row', () => {
    const seq = store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: Buffer.from('{}') });
    store.patch(seq, { sectionsJson: '{"system":100}' });
    const rows = store.list({ limit: 10, afterSeq: 0 });
    expect(rows[0].sectionsJson).toBe('{"system":100}');
  });

  it('keeps only the last 50 rows after writes', () => {
    for (let i = 0; i < 60; i++) {
      store.write({ ts: i, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: Buffer.from(`${i}`) });
    }
    const rows = store.list({ limit: 100, afterSeq: 0 });
    expect(rows).toHaveLength(50);
    expect(rows[0].ts).toBe(10); // first 10 pruned
    expect(rows[49].ts).toBe(59);
  });

  it('truncates bodies larger than 10MB and flags truncated=true', () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61); // 11 MB of 'a'
    const seq = store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body: big });
    const rows = store.list({ limit: 1, afterSeq: 0 });
    expect(rows[0].truncated).toBe(true);
    expect(rows[0].requestBody.length).toBe(10 * 1024 * 1024);
    expect(rows[0].requestBytes).toBe(11 * 1024 * 1024); // original length preserved
    expect(seq).toBe(1);
  });
});
```

- [ ] **Step 6: Run all store tests**

Run: `pnpm exec vitest run src/proxy-payload-log/store.test.ts`
Expected: PASS — 7 passed.

- [ ] **Step 7: Commit**

```bash
git add src/proxy-payload-log/store.ts src/proxy-payload-log/store.test.ts
git commit -m "feat(proxy-payload-log): per-session storage layer with 50-row retention"
```

---

## Task 2: Section parser (`sections.ts`)

**Files:**
- Create: `src/proxy-payload-log/sections.ts`
- Create: `src/proxy-payload-log/sections.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/proxy-payload-log/sections.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseSections } from './sections.js';

describe('parseSections', () => {
  it('parses an anthropic request into system / tools / messages', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        system: 'You are helpful.',
        tools: [{ name: 'bash', description: 'run shell' }],
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      }),
    );
    const s = parseSections('anthropic', body);
    expect(s.system).toBeGreaterThan(0);
    expect(s.tools).toBeGreaterThan(0);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].bytes).toBeGreaterThan(0);
  });

  it('parses an openai request into system+instructions / tools / messages', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-5.4',
        instructions: 'You are helpful.',
        tools: [{ type: 'function', function: { name: 'bash' } }],
        messages: [
          { role: 'system', content: 'system msg' },
          { role: 'user', content: 'hello' },
        ],
      }),
    );
    const s = parseSections('openai', body);
    expect(s.system).toBeGreaterThan(0); // instructions + role:system message
    expect(s.tools).toBeGreaterThan(0);
    // role:system is folded into system bucket, leaving 1 message
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('user');
  });

  it('returns empty sections for an unparseable body', () => {
    const body = Buffer.from('not json');
    const s = parseSections('anthropic', body);
    expect(s.system).toBe(0);
    expect(s.tools).toBe(0);
    expect(s.messages).toEqual([]);
    expect(s.unparseable).toBe(true);
  });

  it('treats clemson, openai-platform, and omlx routes as openai-shaped', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    for (const route of ['openai-platform', 'omlx', 'clemson']) {
      const s = parseSections(route, body);
      expect(s.unparseable).toBe(false);
      expect(s.messages).toHaveLength(1);
    }
  });

  it('records total bytes', () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    const s = parseSections('openai', body);
    expect(s.totalBytes).toBe(body.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/proxy-payload-log/sections.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `sections.ts`**

Create `src/proxy-payload-log/sections.ts`:

```typescript
/**
 * Pure parser: captured LLM request body → Sections shape.
 * Branches by upstream_route; all OpenAI-compatible routes (openai,
 * openai-platform, omlx, clemson) share the same shape.
 */

export interface MessageSection {
  role: string;
  bytes: number;
}

export interface Sections {
  system: number; // bytes attributed to system prompt / instructions
  tools: number; // bytes attributed to tool definitions
  messages: MessageSection[]; // per-message bytes, excluding any folded into `system`
  totalBytes: number;
  unparseable: boolean;
}

function byteLengthOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

export function parseSections(upstreamRoute: string, body: Buffer): Sections {
  const totalBytes = body.length;
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { system: 0, tools: 0, messages: [], totalBytes, unparseable: true };
  }
  if (typeof json !== 'object' || json === null) {
    return { system: 0, tools: 0, messages: [], totalBytes, unparseable: true };
  }
  const obj = json as Record<string, unknown>;

  if (upstreamRoute === 'anthropic') {
    return {
      system: byteLengthOf(obj.system),
      tools: byteLengthOf(obj.tools),
      messages: Array.isArray(obj.messages)
        ? (obj.messages as Array<{ role?: string }>).map((m) => ({
            role: typeof m.role === 'string' ? m.role : 'unknown',
            bytes: byteLengthOf(m),
          }))
        : [],
      totalBytes,
      unparseable: false,
    };
  }

  // openai / openai-platform / omlx / clemson — all share the OpenAI chat shape.
  // `instructions` is OpenAI's top-level system field; role:'system' messages
  // are also conventionally part of the system bucket.
  const instructionsBytes = byteLengthOf(obj.instructions);
  let systemFromMessages = 0;
  const userMessages: MessageSection[] = [];
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages as Array<{ role?: string }>) {
      const role = typeof m.role === 'string' ? m.role : 'unknown';
      const bytes = byteLengthOf(m);
      if (role === 'system') {
        systemFromMessages += bytes;
      } else {
        userMessages.push({ role, bytes });
      }
    }
  }
  return {
    system: instructionsBytes + systemFromMessages,
    tools: byteLengthOf(obj.tools),
    messages: userMessages,
    totalBytes,
    unparseable: false,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/proxy-payload-log/sections.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-payload-log/sections.ts src/proxy-payload-log/sections.test.ts
git commit -m "feat(proxy-payload-log): section parser for anthropic + openai-shaped routes"
```

---

## Task 3: Container env injection (`container-runner.ts`)

**Files:**
- Modify: `src/container-runner.ts` around line 559 (where `X_NANOCLAW_AGENT_GROUP` is set)

- [ ] **Step 1: Identify the insertion point**

Read `src/container-runner.ts` around the line that pushes `X_NANOCLAW_AGENT_GROUP`:

```bash
grep -n 'X_NANOCLAW_AGENT_GROUP' src/container-runner.ts
```

Expected: one match in `buildContainerArgs` near line 559.

- [ ] **Step 2: Locate the session-id source in buildContainerArgs**

Read enough of `buildContainerArgs` to confirm whether a session id is available in scope. If `buildContainerArgs` does not currently receive a session id, check the caller (`buildAndRun` / spawn flow) and either thread it through or compute it.

```bash
grep -n 'buildContainerArgs\|sessionId\|session_id' src/container-runner.ts | head -20
```

If a session-id parameter does not exist on `buildContainerArgs`, add one as the next optional parameter and pass it from the caller. If multiple callers need to be updated, capture each in a sub-step.

- [ ] **Step 3: Add the env var injection**

In `src/container-runner.ts`, immediately after the existing block that pushes `X_NANOCLAW_AGENT_GROUP` (currently `args.push('-e', \`X_NANOCLAW_AGENT_GROUP=${agentGroup.id}\`);`), add:

```typescript
  // Per-call session attribution for the credential proxy's payload log.
  // The container's proxy-fetch wrapper injects this as
  // `X-NanoClaw-Session-Id` on every outbound request to the proxy.
  // Missing-header requests fall back to the agent-group's
  // `unattributed.db` store; harmless.
  if (sessionId) {
    args.push('-e', `X_NANOCLAW_SESSION_ID=${sessionId}`);
  }
```

If you added `sessionId` as a new `buildContainerArgs` parameter in Step 2, update the call sites accordingly.

- [ ] **Step 4: Verify the host still compiles**

Run: `pnpm run build`
Expected: clean build, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(container-runner): inject X_NANOCLAW_SESSION_ID env for payload-log attribution"
```

---

## Task 4: Container proxy-fetch wrapper

**Files:**
- Modify: `container/agent-runner/src/proxy-fetch.ts`
- Modify: `container/agent-runner/src/proxy-fetch.test.ts`

- [ ] **Step 1: Read the existing wrapper**

Read `container/agent-runner/src/proxy-fetch.ts` (74 lines) to confirm the structure used for the agent-group header — the session header follows the same pattern.

- [ ] **Step 2: Add a failing test for session-header propagation**

Open `container/agent-runner/src/proxy-fetch.test.ts` and add (alongside the existing tests):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installProxyFetch } from './proxy-fetch.js';

describe('proxy-fetch session-id header', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = origFetch;
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag1';
    process.env.X_NANOCLAW_SESSION_ID = 'sess1';
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3001';
  });
  afterEach(() => {
    delete process.env.X_NANOCLAW_AGENT_GROUP;
    delete process.env.X_NANOCLAW_SESSION_ID;
    delete process.env.ANTHROPIC_BASE_URL;
    globalThis.fetch = origFetch;
  });

  it('adds X-NanoClaw-Session-Id to proxy-bound requests', async () => {
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit | undefined);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    installProxyFetch();
    await fetch('http://127.0.0.1:3001/v1/messages', { method: 'POST', body: '{}' });
    expect(capturedHeaders?.get('X-NanoClaw-Session-Id')).toBe('sess1');
    expect(capturedHeaders?.get('X-NanoClaw-Agent-Group')).toBe('ag1');
  });

  it('does NOT add the session header to non-proxy requests', async () => {
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit | undefined);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    installProxyFetch();
    await fetch('https://api.example.com/something', { method: 'GET' });
    expect(capturedHeaders?.get('X-NanoClaw-Session-Id')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test from the container package**

Run: `cd container/agent-runner && bun test src/proxy-fetch.test.ts`
Expected: FAIL — the wrapper does not yet add the session header.

- [ ] **Step 4: Update `proxy-fetch.ts`**

Edit `container/agent-runner/src/proxy-fetch.ts`. Change the top header-name constant block from:

```typescript
const HEADER_NAME = 'X-NanoClaw-Agent-Group';
```

to:

```typescript
const AGENT_GROUP_HEADER = 'X-NanoClaw-Agent-Group';
const SESSION_ID_HEADER = 'X-NanoClaw-Session-Id';
```

Replace the body of `installProxyFetch` to read both env vars and inject both headers (only when set):

```typescript
export function installProxyFetch(): void {
  const wrappedMarker = Symbol.for('nanoclaw.proxy-fetch-installed');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis.fetch as any)?.[wrappedMarker]) return;

  const agentGroupId = process.env.X_NANOCLAW_AGENT_GROUP;
  const sessionId = process.env.X_NANOCLAW_SESSION_ID;
  const proxyOrigin = deriveProxyOrigin();
  // No agent group set OR no proxy origin to match against → nothing to
  // do. (Session id alone is not enough — without an agent group there's
  // nothing existing logic relied on, so we keep the same no-op gate.)
  if (!agentGroupId || !proxyOrigin) return;

  const original = globalThis.fetch;
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!url.startsWith(proxyOrigin)) {
      return original(input, init);
    }
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    if (!headers.has(AGENT_GROUP_HEADER)) headers.set(AGENT_GROUP_HEADER, agentGroupId);
    if (sessionId && !headers.has(SESSION_ID_HEADER)) headers.set(SESSION_ID_HEADER, sessionId);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wrapped as any)[wrappedMarker] = true;
  globalThis.fetch = wrapped;
}
```

- [ ] **Step 5: Verify the test passes + the existing tests still pass**

Run: `cd container/agent-runner && bun test src/proxy-fetch.test.ts`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/proxy-fetch.ts container/agent-runner/src/proxy-fetch.test.ts
git commit -m "feat(container/proxy-fetch): propagate X-NanoClaw-Session-Id alongside agent-group"
```

---

## Task 5: Wire the store into the credential proxy

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/credential-proxy.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Identify the call site**

Read `src/credential-proxy.ts:382` — the existing `const body = Buffer.concat(chunks);` line. Then read line 400 (existing `AGENT_GROUP_HEADER` read) and line 411 (start of the upstream routing if/else). The new code goes between body assembly and the upstream request.

- [ ] **Step 2: Add a failing test for proxy → store integration**

Append to `src/credential-proxy.test.ts` a new describe block:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('credential-proxy payload log', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let payloadDir: string;

  beforeEach(async () => {
    payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-payloads-'));
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    fs.rmSync(payloadDir, { recursive: true, force: true });
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it('writes a payload row when a request flows through the proxy', async () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-test';
    proxyServer = await startCredentialProxy({
      port: 0,
      anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      openaiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      omlxBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      clemsonBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      googleBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      payloadLogBaseDir: payloadDir,
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-nanoclaw-agent-group': 'ag1',
          'x-nanoclaw-session-id': 'sess1',
          'content-type': 'application/json',
        },
      },
      JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    );

    // Wait briefly for the patch to settle.
    await new Promise((r) => setTimeout(r, 50));

    const dbPath = path.join(payloadDir, 'ag1', 'sess1.db');
    expect(fs.existsSync(dbPath)).toBe(true);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT seq, upstream_route, response_status FROM payloads').all() as Array<{
      seq: number;
      upstream_route: string;
      response_status: number | null;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].upstream_route).toBe('anthropic');
    expect(rows[0].response_status).toBe(200);
  });

  it('still forwards the request when payload-store write fails', async () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-test';
    // Point at a directory we cannot write to so openStore fails on mkdir.
    proxyServer = await startCredentialProxy({
      port: 0,
      anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      openaiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      omlxBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      clemsonBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      googleBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      payloadLogBaseDir: '/dev/null/not-a-dir',
    });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-nanoclaw-agent-group': 'ag1',
          'x-nanoclaw-session-id': 'sess1',
          'content-type': 'application/json',
        },
      },
      JSON.stringify({ model: 'claude', messages: [] }),
    );
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `startCredentialProxy` does not accept `payloadLogBaseDir` and does not write to the store.

- [ ] **Step 4: Plumb `payloadLogBaseDir` through `startCredentialProxy`**

In `src/credential-proxy.ts`, find the `startCredentialProxy` options type and add the new field:

```typescript
payloadLogBaseDir?: string; // when set, capture request bodies per session
```

Near the existing helpers, add:

```typescript
import { openStore, type PayloadStore } from './proxy-payload-log/store.js';

const SESSION_ID_HEADER = 'x-nanoclaw-session-id';

interface PayloadLogCtx {
  baseDir: string;
  stores: Map<string, PayloadStore>;
}

function getStore(ctx: PayloadLogCtx, agentGroupId: string, sessionId: string): PayloadStore | null {
  const key = `${agentGroupId}|${sessionId}`;
  let s = ctx.stores.get(key);
  if (s) return s;
  try {
    s = openStore({ baseDir: ctx.baseDir, agentGroupId, sessionId });
    ctx.stores.set(key, s);
    return s;
  } catch (err) {
    log.error('proxy-payload-log: openStore failed', { agentGroupId, sessionId, err });
    return null;
  }
}
```

Inside `startCredentialProxy`, after options are normalized:

```typescript
const payloadLogCtx: PayloadLogCtx | null = options.payloadLogBaseDir
  ? { baseDir: options.payloadLogBaseDir, stores: new Map() }
  : null;
```

In the existing `req.on('end', async () => { const body = Buffer.concat(chunks); ... })` handler, after `body` is built and after `agentGroupId` is resolved (around line 400), add:

```typescript
const rawSessionId = req.headers[SESSION_ID_HEADER];
const sessionId =
  typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : 'unattributed';

// Capture the request body for the trace/context panel + B5 forensics.
// Failures NEVER stop the upstream request from proceeding.
let payloadSeq: number | null = null;
if (payloadLogCtx && agentGroupId) {
  const store = getStore(payloadLogCtx, agentGroupId, sessionId);
  if (store) {
    try {
      const route = isOpenAIPlatform
        ? 'openai-platform'
        : isOpenAI
          ? 'openai'
          : isOmlx
            ? 'omlx'
            : isClemson
              ? 'clemson'
              : isGoogle
                ? 'googleapis'
                : 'anthropic';
      payloadSeq = store.write({
        ts: Date.now(),
        upstreamRoute: route,
        upstreamPath,
        body,
      });
    } catch (err) {
      log.error('proxy-payload-log: write failed', { agentGroupId, sessionId, err });
      payloadSeq = null;
    }
  }
}
```

Strip the new session header from upstream forwarding alongside the existing agent-group header strip:

```typescript
delete headers[SESSION_ID_HEADER];
```

In the upstream response handler (`upstream.on('response', (upstreamRes) => { ... })`), add a `'end'` listener on `upstreamRes` that patches the row:

```typescript
upstreamRes.on('end', () => {
  if (payloadSeq != null && payloadLogCtx && agentGroupId) {
    const store = getStore(payloadLogCtx, agentGroupId, sessionId);
    if (store) {
      try {
        store.patch(payloadSeq, { responseStatus: upstreamRes.statusCode ?? 0 });
      } catch (err) {
        log.error('proxy-payload-log: patch failed', { payloadSeq, err });
      }
    }
  }
});
```

`better-sqlite3` is synchronous so no promise dispatch is required; the patch returns before the next tick.

- [ ] **Step 5: Wire the host startup to pass `payloadLogBaseDir`**

In `src/index.ts`, locate the `startCredentialProxy` call:

```bash
grep -n 'startCredentialProxy' src/index.ts
```

Edit the call to include:

```typescript
payloadLogBaseDir: path.join(process.cwd(), 'data', 'proxy-payloads'),
```

Match the surrounding option-object style. If there is already a `DATA_DIR` constant in scope, use that instead of `process.cwd()`.

- [ ] **Step 6: Run all proxy tests**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS — all existing tests + the two new ones.

- [ ] **Step 7: Run the full host test suite**

Run: `pnpm test`
Expected: PASS — no regressions.

- [ ] **Step 8: Run the host build**

Run: `pnpm run build`
Expected: clean build.

- [ ] **Step 9: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts src/index.ts
git commit -m "feat(credential-proxy): capture request bodies to per-session payload log"
```

---

## Task 6: Read endpoint (`GET /api/sessions/:id/payloads`)

**Files:**
- Create: `src/channels/playground/api/payloads.ts`
- Create: `src/channels/playground/api/payloads.test.ts`
- Modify: `src/channels/playground/api-routes.ts`

- [ ] **Step 1: Read the existing handler patterns**

Open `src/channels/playground/api/class-controls.ts` and `src/channels/playground/api-routes.ts:340-400` to confirm the `handleX(...) → ApiResult<T>` pattern and route-registration style. The new handler follows the same shape.

- [ ] **Step 2: Write the failing test**

Create `src/channels/playground/api/payloads.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGetSessionPayloads } from './payloads.js';
import { openStore } from '../../../proxy-payload-log/store.js';

describe('handleGetSessionPayloads', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payloads-api-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 when the session db does not exist', async () => {
    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'missing',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 when access is denied', async () => {
    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => false,
    });
    expect(res.status).toBe(401);
  });

  it('returns rows + parsed sections for an existing session', async () => {
    const store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
    const body = Buffer.from(
      JSON.stringify({ model: 'claude', system: 'be helpful', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const seq = store.write({ ts: 1000, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.patch(seq, { responseStatus: 200 });
    store.close();

    const res = await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });
    expect(res.status).toBe(200);
    const body200 = res.body as { rows: Array<{ sections: { system: number; messages: unknown[] }; responseStatus: number | null }> };
    expect(body200.rows).toHaveLength(1);
    expect(body200.rows[0].sections.system).toBeGreaterThan(0);
    expect(body200.rows[0].sections.messages).toHaveLength(1);
    expect(body200.rows[0].responseStatus).toBe(200);
  });

  it('caches sections_json back to the row after first parse', async () => {
    const store = openStore({ baseDir: tmpDir, agentGroupId: 'ag1', sessionId: 'sess1' });
    const body = Buffer.from(JSON.stringify({ model: 'claude', messages: [] }));
    store.write({ ts: 1, upstreamRoute: 'anthropic', upstreamPath: '/v1/messages', body });
    store.close();

    await handleGetSessionPayloads({
      baseDir: tmpDir,
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      limit: 10,
      afterSeq: 0,
      canAccess: () => true,
    });

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tmpDir, 'ag1', 'sess1.db'), { readonly: true });
    const row = db.prepare('SELECT sections_json FROM payloads').get() as { sections_json: string | null };
    db.close();
    expect(row.sections_json).not.toBeNull();
    expect(JSON.parse(row.sections_json as string)).toHaveProperty('totalBytes');
  });
});
```

- [ ] **Step 3: Run to verify the tests fail**

Run: `pnpm exec vitest run src/channels/playground/api/payloads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the handler**

Create `src/channels/playground/api/payloads.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { openStore } from '../../../proxy-payload-log/store.js';
import { parseSections, type Sections } from '../../../proxy-payload-log/sections.js';

export interface ApiResult<T> {
  status: number;
  body: T;
}

export interface PayloadRowOut {
  seq: number;
  ts: number;
  upstreamRoute: string;
  upstreamPath: string;
  requestBytes: number;
  truncated: boolean;
  responseStatus: number | null;
  sections: Sections;
}

export interface PayloadListBody {
  rows: PayloadRowOut[];
}

export interface HandleInput {
  baseDir: string;
  agentGroupId: string;
  sessionId: string;
  limit: number;
  afterSeq: number;
  canAccess: (agentGroupId: string) => boolean;
}

export async function handleGetSessionPayloads(
  input: HandleInput,
): Promise<ApiResult<PayloadListBody | { error: string }>> {
  if (!input.canAccess(input.agentGroupId)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const dbPath = path.join(input.baseDir, input.agentGroupId, `${input.sessionId}.db`);
  if (!fs.existsSync(dbPath)) {
    return { status: 404, body: { error: 'session not found' } };
  }
  const store = openStore({
    baseDir: input.baseDir,
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId,
  });
  try {
    const rows = store.list({ limit: input.limit, afterSeq: input.afterSeq });
    const out: PayloadRowOut[] = rows.map((r) => {
      let sections: Sections;
      if (r.sectionsJson) {
        sections = JSON.parse(r.sectionsJson) as Sections;
      } else {
        sections = parseSections(r.upstreamRoute, r.requestBody);
        try {
          store.patch(r.seq, { sectionsJson: JSON.stringify(sections) });
        } catch {
          /* non-fatal — the panel still got its data */
        }
      }
      return {
        seq: r.seq,
        ts: r.ts,
        upstreamRoute: r.upstreamRoute,
        upstreamPath: r.upstreamPath,
        requestBytes: r.requestBytes,
        truncated: r.truncated,
        responseStatus: r.responseStatus,
        sections,
      };
    });
    return { status: 200, body: { rows: out } };
  } finally {
    store.close();
  }
}
```

- [ ] **Step 5: Run the handler tests**

Run: `pnpm exec vitest run src/channels/playground/api/payloads.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 6: Wire the route**

In `src/channels/playground/api-routes.ts`, add the imports at the top:

```typescript
import path from 'path';
import { handleGetSessionPayloads } from './api/payloads.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
```

(Skip any of these that are already imported.)

Add the route handler in the routing if/else chain, near other session-scoped routes:

```typescript
  // GET /api/sessions/:sessionId/payloads?agentGroupId=...&limit=N&after=seq
  if (method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/payloads')) {
    const sessionId = url.pathname.slice('/api/sessions/'.length, -'/payloads'.length);
    const agentGroupId = url.searchParams.get('agentGroupId') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const afterSeq = Number(url.searchParams.get('after') ?? '0');
    const userId = session.userId ?? '';
    const r = await handleGetSessionPayloads({
      baseDir: path.join(process.cwd(), 'data', 'proxy-payloads'),
      agentGroupId,
      sessionId,
      limit,
      afterSeq,
      canAccess: (ag) => canAccessAgentGroup(userId, ag),
    });
    return send(res, r.status, r.body);
  }
```

- [ ] **Step 7: Verify build + tests**

Run: `pnpm run build && pnpm test`
Expected: clean build, all tests pass.

- [ ] **Step 8: Manual smoke (optional but recommended)**

Restart the host (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`), trigger a chat turn against any agent, then:

```bash
ls data/proxy-payloads/
pnpm exec tsx scripts/q.ts data/proxy-payloads/<agent-group>/<session>.db 'SELECT seq, upstream_route, request_bytes, response_status FROM payloads'
```

Expected: at least one row for the just-completed turn.

- [ ] **Step 9: Commit**

```bash
git add src/channels/playground/api/payloads.ts src/channels/playground/api/payloads.test.ts src/channels/playground/api-routes.ts
git commit -m "feat(api): GET /api/sessions/:id/payloads handler for trace/context panel"
```

---

## Verification (run after all tasks)

- `pnpm run build` clean.
- `pnpm test` all green; agent-runner tests green: `cd container/agent-runner && bun test`.
- `data/proxy-payloads/` is created on first turn after a host restart.
- Each per-session `.db` file holds at most 50 rows after sustained use.
- `GET /api/sessions/:sessionId/payloads?agentGroupId=...` returns a JSON list with parsed `sections` after access check.

## Out of scope (deferred to sibling spec / Arc B)

- The Chat trace/context panel UI that consumes this endpoint — separate spec.
- Instructor-Home toggle to enable/disable capture — folds into Arc B (Home revamp).
- Long-thread forensic mode that bypasses the 50-row prune — only if asked.
