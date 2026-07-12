/**
 * NanoClaw agent-harness benchmark runner — B1+B2+B3 + MCP reliability suite.
 *
 * CLI: pnpm exec tsx scripts/bench.ts --source <folder> --systems <comma-list> --reps <n> --suite <default|mcp>
 *
 * Systems (pass as comma-separated list to --systems) — all pi provider, routed
 * by model_provider through the credential proxy (`clemson` → Clemson RCD LLM
 * endpoint, `local` → local MLX server):
 *   clemson-qwen36      model_provider clemson + qwen3.6-35b-a3b-fp8            (default)
 *   clemson-qwen3-30b   model_provider clemson + qwen3-30b-a3b-instruct-fp8
 *   clemson-glm51       model_provider clemson + glm-5.1-fp8
 *   local-qwen36        model_provider local   + Qwen3.6-35B-A3B-UD-MLX-4bit (requires local MLX server)
 *   local-gemma4        model_provider local   + gemma-4-26B-A4B-it-QAT-MLX-4bit (requires local MLX server)
 *
 * Full matrix: --systems clemson-qwen36,clemson-qwen3-30b,clemson-glm51,local-qwen36,local-gemma4
 * (Omit the local-* systems if the local MLX server isn't running.)
 *
 * Suites:
 *   --suite default (default) — B1+B2+B3 prompts from bench-prompts.json, scored via bench-gates.ts + LLM judge.
 *   --suite mcp                — MCP reliability tasks from bench-prompts-mcp.json, scored by reading
 *                                 outbound.db directly (tool invocation + answer grounding) via bench-mcp-score.ts.
 *
 * Workflow (default suite):
 *   1. Verify the playground server is reachable on http://127.0.0.1:3002
 *   2. Start the fixture server on localhost:7777
 *   3. Provision (or refresh) the bench agent group for each system under test
 *   4. Obtain a bench session cookie via /api/bench/session
 *   5. For each (system × request × rep): send a message, stream SSE events, capture metrics
 *   6. Persist events + aggregated metrics + LLM-judge score to data/benchmarks.db
 *   7. Stop the fixture server
 *   8. Print summary
 *
 * Workflow (mcp suite): same provisioning + auth, then for each (system × task):
 * clear the continuation, send the prompt, read the fresh outbound.db rows since the
 * pre-turn max seq, and score tool use / grounding / exact-match. No DB persistence yet
 * (the markdown report renderer is a follow-up task) — just a console summary.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { startFixtureServer, stopFixtureServer, FIXTURE_PORT } from './bench-fixture-server.js';
import { computeCost, insertEvent, insertRun } from './bench-db.js';
import { judgeOutput } from './bench-judge.js';
import { runGate } from './bench-gates.js';
import { readTurnOutbound, toolInvoked, answerGrounded, matchesExpected } from './bench-mcp-score.js';
import { CONTAINER_HOST_GATEWAY } from '../src/container-runtime.js';

// -- Resolve project root from __dirname (scripts/) -------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

// -- Load prompts -----------------------------------------------------------
const PROMPTS_PATH = path.join(__dirname, 'bench-prompts.json');
interface SinglePrompt {
  id: string;
  kind: 'single';
  prompt: string;
  gate: string;
  expected: unknown;
}
interface MultiPrompt {
  id: string;
  kind: 'multi';
  prompts: string[];
  gate: string;
  expected: unknown;
}
type BenchPrompt = SinglePrompt | MultiPrompt;

const BENCH_PROMPTS: BenchPrompt[] = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8')) as BenchPrompt[];

// -- MCP reliability suite prompts -------------------------------------------
const MCP_PROMPTS_PATH = path.join(__dirname, 'bench-prompts-mcp.json');
interface McpTask {
  id: string;
  kind: 'single';
  prompt: string;
  expectedTool?: string;
  gate: string;
  expected: string | null;
}
const MCP_TASKS: McpTask[] = JSON.parse(fs.readFileSync(MCP_PROMPTS_PATH, 'utf8')) as McpTask[];

// -- Fixture URL rewriting --------------------------------------------------
// Prompts use http://127.0.0.1:7777/ as a canonical placeholder.
// Apple Container VMs reach the host via the bridge gateway IP, not 127.0.0.1.
// We rewrite URLs in prompts at send time so the containers can actually fetch them.
function rewriteFixtureUrls(text: string): string {
  const localBase = `http://127.0.0.1:${FIXTURE_PORT}/`;
  const gatewayBase = `http://${CONTAINER_HOST_GATEWAY}:${FIXTURE_PORT}/`;
  return text.split(localBase).join(gatewayBase);
}

// -- System definitions (pi-only roster; model_provider drives credential-proxy routing) --
interface BenchSystem {
  provider: string;
  model: string;
  modelProvider: string;
  label: string;
}
const SYSTEMS: Record<string, BenchSystem> = {
  'clemson-qwen36': {
    provider: 'pi',
    model: 'qwen3.6-35b-a3b-fp8',
    modelProvider: 'clemson',
    label: 'clemson-qwen36',
  },
  'clemson-qwen3-30b': {
    provider: 'pi',
    model: 'qwen3-30b-a3b-instruct-fp8',
    modelProvider: 'clemson',
    label: 'clemson-qwen3-30b',
  },
  'clemson-glm51': {
    provider: 'pi',
    model: 'glm-5.1-fp8',
    modelProvider: 'clemson',
    label: 'clemson-glm51',
  },
  'local-qwen36': {
    provider: 'pi',
    model: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
    modelProvider: 'local',
    label: 'local-qwen36',
  },
  'local-gemma4': {
    provider: 'pi',
    model: 'gemma-4-26B-A4B-it-QAT-MLX-4bit',
    modelProvider: 'local',
    label: 'local-gemma4',
  },
};

// -- CLI parsing ------------------------------------------------------------
function parseArgs(): { source: string; systems: string[]; reps: number; suite: 'default' | 'mcp' } {
  const args = process.argv.slice(2);
  let source = 'dm-with-chiptonkin';
  let systems = ['clemson-qwen36'];
  let reps = 3;
  let suite: 'default' | 'mcp' = 'default';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) {
      source = args[++i]!;
    } else if (args[i] === '--systems' && args[i + 1]) {
      systems = args[++i]!.split(',').map((s) => s.trim());
    } else if (args[i] === '--reps' && args[i + 1]) {
      reps = parseInt(args[++i]!, 10);
    } else if (args[i] === '--suite' && args[i + 1]) {
      const val = args[++i]!;
      if (val !== 'default' && val !== 'mcp') {
        throw new Error(`Unknown --suite value: ${val}. Supported: default, mcp`);
      }
      suite = val;
    }
  }

  return { source, systems, reps, suite };
}

// -- HTTP helpers -----------------------------------------------------------
const PLAYGROUND_BASE = 'http://127.0.0.1:3002';
const TIMEOUT_MS = 300_000; // 5 minutes per turn

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('Request timed out')); });
  });
}

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parseInt(parsedUrl.port || '80', 10),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// -- Auth -------------------------------------------------------------------
async function obtainSessionCookie(): Promise<string> {
  const resp = await httpGet(`${PLAYGROUND_BASE}/api/bench/session`);
  if (resp.status !== 200) {
    throw new Error(
      `Failed to obtain bench session (HTTP ${resp.status}). ` +
      'Is BENCH_MODE=1 set on the host service? Check that the playground server is running on port 3002.',
    );
  }
  const parsed = JSON.parse(resp.body) as { cookieValue?: string };
  if (!parsed.cookieValue) throw new Error('bench/session response missing cookieValue');
  return `nc_playground=${parsed.cookieValue}`;
}

// -- Bench agent group provisioning ----------------------------------------

function benchFolder(systemKey: string, sourceFolder: string): string {
  // bench_<system>_<source>   e.g. bench_claude-sonnet_dm-with-chiptonkin
  return `bench_${systemKey}_${sourceFolder}`;
}

// Inline minimal DB access for provisioning — we import from host src/ via tsx.
// tsx can resolve these at runtime (they're compiled-compatible TS imports).
async function provisionBenchGroup(
  systemKey: string,
  sourceFolder: string,
  system: BenchSystem,
  sessionCookie: string,
): Promise<void> {
  const folder = benchFolder(systemKey, sourceFolder);
  const sourceDir = path.join(GROUPS_DIR, sourceFolder);
  const benchDir = path.join(GROUPS_DIR, folder);

  // Determine if bench group row exists by asking the playground API.
  // We can query /api/groups and look for our folder.
  const groupsResp = await httpGet(`${PLAYGROUND_BASE}/api/groups`, { cookie: sessionCookie });
  if (groupsResp.status !== 200) {
    throw new Error(`Failed to list agent groups (HTTP ${groupsResp.status})`);
  }
  const allGroups = JSON.parse(groupsResp.body) as Array<{ folder: string; id: string }>;
  const existing = allGroups.find((g) => g.folder === folder);

  if (!existing) {
    // Create the agent group by calling a thin provisioning endpoint.
    // The playground's POST /api/drafts creates a draft — but we want a non-draft bench group.
    // There is no direct REST endpoint to create arbitrary named agent groups.
    // Per the spec: provision directly, not via createDraft. We'll do this by
    // importing the DB helpers inline via dynamic import (tsx resolves src/ TS).
    console.log(`  Provisioning new bench group: ${folder}`);
    await createBenchGroupViaDb(folder, sourceFolder, system);
  } else {
    console.log(`  Bench group exists: ${folder} — refreshing config files`);
  }

  // Model routing is DB-authoritative: container-runner.ts materializes
  // container.json from the container_configs DB row at every spawn, so the
  // file write below is scaffolding only — the DB row set here is what wins.
  await ensureDbInitialized();
  const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
  const {
    ensureContainerConfig,
    updateContainerConfigScalars,
    updateContainerConfigJson,
    getContainerConfig,
  } = await import('../src/db/container-configs.js');

  const ag = getAgentGroupByFolder(folder);
  if (!ag) throw new Error(`Bench group "${folder}" not found in DB after provisioning`);

  ensureContainerConfig(ag.id);
  updateContainerConfigScalars(ag.id, {
    provider: 'pi',
    model: system.model,
    model_provider: system.modelProvider,
  });

  // Seed the MCP tool catalog from owner_01 so the agent has the
  // catalog/scheduling/curriculum tools the MCP suite exercises.
  const ownerAg = getAgentGroupByFolder('owner_01');
  if (ownerAg) {
    const ownerConfig = getContainerConfig(ownerAg.id);
    if (ownerConfig) {
      updateContainerConfigJson(ag.id, 'mcp_servers', JSON.parse(ownerConfig.mcp_servers));
      updateContainerConfigJson(ag.id, 'skills', JSON.parse(ownerConfig.skills));
    }
  }

  // Always re-copy config files from source to keep bench fresh.
  fs.mkdirSync(benchDir, { recursive: true });

  for (const filename of ['CLAUDE.md', 'CLAUDE.local.md', 'container.json']) {
    const src = path.join(sourceDir, filename);
    const dst = path.join(benchDir, filename);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Best-effort scaffolding copy of container.json — not authoritative for
  // routing (see comment above), but keeps the file in sync for inspection.
  const containerJsonPath = path.join(benchDir, 'container.json');
  let containerConfig: Record<string, unknown> = {};
  if (fs.existsSync(containerJsonPath)) {
    try {
      containerConfig = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
      containerConfig = {};
    }
  }
  containerConfig['provider'] = system.provider;
  containerConfig['model'] = system.model;
  containerConfig['modelProvider'] = system.modelProvider;
  containerConfig['agentGroupId'] = ag.id;
  fs.writeFileSync(containerJsonPath, JSON.stringify(containerConfig, null, 2) + '\n');

  // Ensure messaging group + wiring exist via the messages POST endpoint
  // (it calls ensureDraftMessagingGroup + ensureDraftWiring internally).
  // We'll do this as part of the first send, so nothing extra needed here.
}

async function ensureDbInitialized(): Promise<void> {
  const { initDb, getDb } = await import('../src/db/connection.js');
  // Only init if not already open. getDb() throws if not initialized.
  try {
    getDb();
  } catch {
    const dbPath = path.join(PROJECT_ROOT, 'data', 'v2.db');
    const db = initDb(dbPath);
    // Run migrations on the opened DB.
    const { runMigrations } = await import('../src/db/migrations/index.js');
    runMigrations(db);
  }
}

async function createBenchGroupViaDb(
  folder: string,
  _sourceFolder: string,
  system: BenchSystem,
): Promise<void> {
  // Dynamic import of host DB layer — tsx resolves .ts files.
  // This runs in the same process so the DB connection is shared
  // with the running host (WAL mode, concurrent readers are fine).
  await ensureDbInitialized();
  const { createAgentGroup, getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
  const { ensureDraftMessagingGroup, ensureDraftWiring } = await import('../src/agent-builder/core.js');

  const existing = getAgentGroupByFolder(folder);
  if (existing) return; // idempotent

  const id = `bench_${crypto.randomBytes(6).toString('hex')}`;
  createAgentGroup({
    id,
    name: folder,
    folder,
    agent_provider: system.provider,
    created_at: new Date().toISOString(),
  });

  // Wire up playground messaging group so the messages API can drive it.
  ensureDraftMessagingGroup(folder);
  ensureDraftWiring(folder);
}

async function clearContinuation(
  systemKey: string,
  sourceFolder: string,
): Promise<void> {
  const folder = benchFolder(systemKey, sourceFolder);
  // The continuation lives in outbound.db under data/v2-sessions/<ag_id>/<sess_id>/
  // We need the agent_group_id to find the session.
  await ensureDbInitialized();
  const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
  const { getActiveSessions } = await import('../src/db/sessions.js');
  const ag = getAgentGroupByFolder(folder);
  if (!ag) return;

  // Find active sessions for this agent group.
  const sessions = getActiveSessions().filter((s) => s.agent_group_id === ag.id);
  const { isContainerRunning, killContainer } = await import('../src/container-runner.js');

  for (const sess of sessions) {
    // Kill any running container so the next spawn picks up fresh container.json.
    if (isContainerRunning(sess.id)) {
      try {
        killContainer(sess.id, 'bench: fresh thread requested');
      } catch {
        // best-effort — container may have just exited
      }
    }

    const outboundPath = path.join(PROJECT_ROOT, 'data', 'v2-sessions', ag.id, sess.id, 'outbound.db');
    if (!fs.existsSync(outboundPath)) continue;
    // Open outbound.db and delete continuation:* rows.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(outboundPath);
    try {
      db.pragma('journal_mode = DELETE');
      db.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run();
    } finally {
      db.close();
    }
  }

  // Brief pause to let the container exit before the next run starts.
  if (sessions.length > 0) {
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
}

// -- SSE streaming ----------------------------------------------------------

interface SseMessageEvent {
  kind: 'chat' | 'trace' | string;
  content?: unknown;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  latencyMs?: number;
  provider?: string;
  model?: string;
  type?: string;
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
}

interface TurnResult {
  outputText: string;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheCreation: number | null;
  numToolCalls: number;
  latencyMs: number | null;
  provider: string | null;
  model: string | null;
  rawEvents: string[];
}

/**
 * Send a message to the bench agent group and collect the SSE stream
 * until a chat-kind event arrives (the final agent reply).
 *
 * Timeout: TIMEOUT_MS. Returns TurnResult.
 */
async function sendAndCollect(
  folder: string,
  text: string,
  sessionCookie: string,
): Promise<TurnResult> {
  // 1. Open SSE stream before posting the message so we don't miss early events.
  const streamUrl = `${PLAYGROUND_BASE}/api/drafts/${folder}/stream`;
  const rawEvents: string[] = [];
  let resolve!: (r: TurnResult) => void;
  let reject!: (e: Error) => void;

  const resultPromise = new Promise<TurnResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let tokensCacheRead: number | null = null;
  let tokensCacheCreation: number | null = null;
  let numToolCalls = 0;
  let latencyMs: number | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let outputText = '';
  let eventSeq = 0;
  let settled = false;

  const parsedStreamUrl = new URL(streamUrl);
  const streamOptions: http.RequestOptions = {
    hostname: parsedStreamUrl.hostname,
    port: parseInt(parsedStreamUrl.port || '80', 10),
    path: parsedStreamUrl.pathname,
    method: 'GET',
    headers: {
      cookie: sessionCookie,
      accept: 'text/event-stream',
    },
  };

  const timeoutHandle = setTimeout(() => {
    if (!settled) {
      settled = true;
      sseReq.destroy();
      reject(new Error(`SSE stream timed out after ${TIMEOUT_MS}ms`));
    }
  }, TIMEOUT_MS);

  let sseBuffer = '';

  const sseReq = http.request(streamOptions, (res) => {
    if (res.statusCode !== 200) {
      clearTimeout(timeoutHandle);
      settled = true;
      reject(new Error(`SSE stream returned HTTP ${res.statusCode}`));
      return;
    }

    res.setEncoding('utf8');

    res.on('data', (chunk: string) => {
      sseBuffer += chunk;
      // Parse SSE frames: each frame ends with double newline.
      const frames = sseBuffer.split(/\n\n/);
      sseBuffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventName = 'message';
        let dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice('event: '.length).trim();
          if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
        }
        if (eventName === 'hello') continue;
        if (!dataLine) continue;

        rawEvents.push(dataLine);
        const seqNum = eventSeq++;

        let parsed: SseMessageEvent;
        try {
          parsed = JSON.parse(dataLine) as SseMessageEvent;
        } catch {
          continue;
        }

        // Store raw event for forensics (truncate very large payloads)
        const rawForDb = dataLine.length > 4096 ? dataLine.slice(0, 4096) + '…' : dataLine;
        void rawForDb; // used in caller's insertEvent calls

        // Extract metrics from chat-kind events (agent final reply).
        if (eventName === 'message' && parsed.kind !== 'trace') {
          // This is the agent's chat reply.
          if (parsed.tokens) {
            if (typeof parsed.tokens.input === 'number') tokensIn = parsed.tokens.input;
            if (typeof parsed.tokens.output === 'number') tokensOut = parsed.tokens.output;
            if (typeof parsed.tokens.cacheRead === 'number') tokensCacheRead = parsed.tokens.cacheRead;
            if (typeof parsed.tokens.cacheCreation === 'number') tokensCacheCreation = parsed.tokens.cacheCreation;
          }
          if (typeof parsed.latencyMs === 'number') latencyMs = parsed.latencyMs;
          if (parsed.provider) provider = parsed.provider;
          if (parsed.model) model = parsed.model;

          // Extract text from content.
          if (typeof parsed.content === 'string') {
            outputText = parsed.content;
          } else if (parsed.content && typeof parsed.content === 'object') {
            const c = parsed.content as { text?: unknown };
            if (typeof c.text === 'string') outputText = c.text;
          }

          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
            sseReq.destroy();
            resolve({
              outputText,
              tokensIn,
              tokensOut,
              tokensCacheRead,
              tokensCacheCreation,
              numToolCalls,
              latencyMs,
              provider,
              model,
              rawEvents,
            });
          }
          return;
        }

        // Count tool calls from trace events.
        if (eventName === 'message' && parsed.kind === 'trace') {
          const traceData = parsed.content as SseMessageEvent | undefined ?? parsed;
          if (traceData.type === 'tool_use') {
            numToolCalls++;
          }
        }
      }
    });

    res.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err as Error);
      }
    });

    res.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutHandle);
        // Stream ended without a chat event — return what we have.
        resolve({
          outputText,
          tokensIn,
          tokensOut,
          tokensCacheRead,
          tokensCacheCreation,
          numToolCalls,
          latencyMs,
          provider,
          model,
          rawEvents,
        });
      }
    });
  });

  sseReq.on('error', (err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutHandle);
      reject(err as Error);
    }
  });

  sseReq.end();

  // 2. Small delay to let the SSE connection establish before posting.
  await new Promise<void>((r) => setTimeout(r, 200));

  // 3. Post the message.
  const msgBody = JSON.stringify({ text });
  const msgResp = await httpPost(
    `${PLAYGROUND_BASE}/api/drafts/${folder}/messages`,
    msgBody,
    { cookie: sessionCookie },
  );
  if (msgResp.status !== 200) {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutHandle);
      sseReq.destroy();
      reject(new Error(`POST /messages returned HTTP ${msgResp.status}: ${msgResp.body}`));
    }
    return resultPromise;
  }

  return resultPromise;
}

// -- MCP reliability suite ---------------------------------------------------
// Scores tool use from outbound.db directly (sendAndCollect's numToolCalls
// field is unused here — it reads a stale trace-event shape).

/** Resolve the bench group's active session outbound.db path, same resolution clearContinuation uses. */
async function resolveOutboundPath(folder: string): Promise<string | undefined> {
  await ensureDbInitialized();
  const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
  const { getActiveSessions } = await import('../src/db/sessions.js');
  const ag = getAgentGroupByFolder(folder);
  if (!ag) return undefined;
  const sessions = getActiveSessions().filter((s) => s.agent_group_id === ag.id);
  if (sessions.length === 0) return undefined;
  const sess = sessions[sessions.length - 1]!;
  const outboundPath = path.join(PROJECT_ROOT, 'data', 'v2-sessions', ag.id, sess.id, 'outbound.db');
  return fs.existsSync(outboundPath) ? outboundPath : undefined;
}

async function getMaxSeq(outboundPath: string | undefined): Promise<number> {
  if (!outboundPath) return 0;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(outboundPath, { readonly: true });
  try {
    const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM messages_out').get() as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  } finally {
    db.close();
  }
}

interface McpResult {
  system: string;
  task: string;
  toolPass: boolean;
  answerPass: boolean;
  latencyMs: number | null;
  errored: boolean;
  reply: string;
}

async function runBenchMcp(
  sourceFolder: string,
  systemKey: string,
  sessionCookie: string,
): Promise<McpResult[]> {
  const system = SYSTEMS[systemKey];
  if (!system) {
    throw new Error(`Unknown system: ${systemKey}. Supported: ${Object.keys(SYSTEMS).join(', ')}`);
  }

  const folder = benchFolder(systemKey, sourceFolder);
  const results: McpResult[] = [];

  console.log(`\nRunning ${MCP_TASKS.length} MCP tasks against ${system.label}`);
  console.log(`Bench agent group: ${folder}\n`);

  for (const task of MCP_TASKS) {
    // Fresh thread per task, same as the default suite between reps.
    await clearContinuation(systemKey, sourceFolder);

    const outboundPathBefore = await resolveOutboundPath(folder);
    const sinceSeq = await getMaxSeq(outboundPathBefore);

    console.log(`  [${task.id}]…`);

    let reply = '';
    let latencyMs: number | null = null;
    let errored = false;
    let toolPass = false;
    let answerPass = false;

    try {
      const turn = await sendAndCollect(folder, task.prompt, sessionCookie);
      reply = turn.outputText;
      latencyMs = turn.latencyMs;

      const outboundPath = (await resolveOutboundPath(folder)) ?? outboundPathBefore;
      if (!outboundPath) {
        throw new Error(`Could not resolve outbound.db for "${folder}" after sending the turn`);
      }
      const outboundTurn = readTurnOutbound(outboundPath, sinceSeq);
      errored = outboundTurn.errored;

      if (task.expectedTool) {
        toolPass = toolInvoked(outboundTurn, task.expectedTool);
        answerPass = answerGrounded(outboundTurn);
      } else {
        toolPass = true; // no tool expected for general tasks
        answerPass = task.expected != null ? matchesExpected(reply, task.expected) : false;
      }
    } catch (err) {
      errored = true;
      reply = String(err);
      console.log(`    ERROR: ${reply}`);
    }

    results.push({ system: system.label, task: task.id, toolPass, answerPass, latencyMs, errored, reply });

    const pass = task.expectedTool ? toolPass && answerPass : answerPass;
    const passStr = errored ? 'ERROR' : pass ? 'PASS' : 'FAIL';
    const latStr = latencyMs != null ? ` · ${latencyMs}ms` : '';
    console.log(`    ${passStr}${latStr}`);
  }

  return results;
}

// -- Main run loop ----------------------------------------------------------

async function runBench(
  sourceFolder: string,
  systemKey: string,
  reps: number,
  sessionCookie: string,
): Promise<{ total: number; passed: number }> {
  const system = SYSTEMS[systemKey];
  if (!system) {
    throw new Error(`Unknown system: ${systemKey}. Supported: ${Object.keys(SYSTEMS).join(', ')}`);
  }

  const folder = benchFolder(systemKey, sourceFolder);
  const runGroupId = `rg_${Date.now()}`;
  let totalRuns = 0;
  let passedGates = 0;

  console.log(`\nRunning ${BENCH_PROMPTS.length} prompts x ${reps} reps against ${system.label}`);
  console.log(`Bench agent group: ${folder}\n`);

  for (const prompt of BENCH_PROMPTS) {
    for (let rep = 1; rep <= reps; rep++) {
      // Clear continuation before each run (fresh thread per rep).
      await clearContinuation(systemKey, sourceFolder);

      const runId = `${runGroupId}_${prompt.id}_${rep}`;
      const startedAt = new Date().toISOString();
      console.log(`  [${prompt.id}] rep ${rep}/${reps}…`);

      const turnOutputs: string[] = [];
      let totalIn = 0;
      let totalOut = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalToolCalls = 0;
      let totalLatency = 0;
      let provider: string | null = null;
      let model: string | null = null;
      let allEvents: string[] = [];
      let runSuccess = true;
      let notes: string | null = null;
      const rawPrompts = prompt.kind === 'single' ? [prompt.prompt] : prompt.prompts;
      const prompts = rawPrompts.map(rewriteFixtureUrls);

      try {

        for (const p of prompts) {
          const turn = await sendAndCollect(folder, p, sessionCookie);
          turnOutputs.push(turn.outputText);
          if (turn.tokensIn != null) totalIn += turn.tokensIn;
          if (turn.tokensOut != null) totalOut += turn.tokensOut;
          if (turn.tokensCacheRead != null) totalCacheRead += turn.tokensCacheRead;
          if (turn.tokensCacheCreation != null) totalCacheCreation += turn.tokensCacheCreation;
          totalToolCalls += turn.numToolCalls;
          if (turn.latencyMs != null) totalLatency += turn.latencyMs;
          if (turn.provider) provider = turn.provider;
          if (turn.model) model = turn.model;
          allEvents = allEvents.concat(turn.rawEvents);
        }
      } catch (err) {
        runSuccess = false;
        notes = String(err);
        console.log(`    ERROR: ${notes}`);
      }

      const outputText = turnOutputs.join('\n\n---\n\n');
      const gateOutput = prompt.kind === 'multi' ? turnOutputs : outputText;
      const gatePass = runSuccess ? runGate(prompt.gate, gateOutput, prompt.expected) : false;

      if (gatePass) passedGates++;
      totalRuns++;

      const costUsd = computeCost(
        provider ?? system.provider,
        model ?? system.model,
        totalIn || null,
        totalOut || null,
        totalCacheRead || null,
        totalCacheCreation || null,
      );

      // B2: LLM-judge quality score (best-effort — non-fatal on failure).
      let qualityScore: number | null = null;
      let judgeRationale: string | null = null;
      if (runSuccess && outputText) {
        const requestText = rawPrompts.join('\n\n---\n\n');
        process.stdout.write('    Judging…');
        const judgeResult = await judgeOutput(requestText, outputText);
        if (judgeResult) {
          qualityScore = judgeResult.score;
          judgeRationale = judgeResult.rationale;
          process.stdout.write(` ${qualityScore}/5\n`);
        } else {
          process.stdout.write(' (skipped)\n');
        }
      }

      // Write run record
      insertRun({
        run_id: runId,
        started_at: startedAt,
        system_under_test: system.label,
        provider: provider ?? system.provider,
        model: model ?? system.model,
        harness_config: null,
        request_id: prompt.id,
        repetition: rep,
        success: runSuccess ? 1 : 0,
        output_text: outputText.slice(0, 10000), // cap stored text
        total_input_tokens: totalIn || null,
        total_cached_tokens: totalCacheRead || null,
        total_cache_creation_tokens: totalCacheCreation || null,
        total_output_tokens: totalOut || null,
        total_reasoning_tokens: null,
        num_api_calls: turnOutputs.length || prompts.length,
        num_tool_calls: totalToolCalls || null,
        latency_ms: totalLatency || null,
        cost_usd: costUsd,
        quality_score: qualityScore,
        programmatic_pass: gatePass ? 1 : 0,
        notes: judgeRationale ?? notes,
      });

      // Write raw events for forensics
      for (let i = 0; i < allEvents.length; i++) {
        const ev = allEvents[i]!;
        insertEvent(runId, i, ev.length > 4096 ? ev.slice(0, 4096) + '…' : ev);
      }

      const gateStr = gatePass ? 'PASS' : 'FAIL';
      const costStr = costUsd != null ? ` · $${costUsd.toFixed(5)}` : '';
      const tokStr = totalIn > 0 ? ` · ${totalIn}in/${totalOut}out` : '';
      const qualStr = qualityScore != null ? ` · quality ${qualityScore}/5` : '';
      console.log(`    ${gateStr}${tokStr}${costStr}${qualStr}`);
    }
  }

  return { total: totalRuns, passed: passedGates };
}

// -- Entry point ------------------------------------------------------------

async function main(): Promise<void> {
  const { source, systems, reps, suite } = parseArgs();

  // Validate systems
  for (const s of systems) {
    if (!SYSTEMS[s]) {
      console.error(`Unknown system: ${s}. Supported: ${Object.keys(SYSTEMS).join(', ')}`);
      process.exit(1);
    }
  }

  // 1. Check playground server reachability
  console.log('Checking playground server…');
  try {
    const resp = await httpGet(`${PLAYGROUND_BASE}/api/groups`, {});
    if (resp.status === 401 || resp.status === 200) {
      console.log(`  Playground reachable (HTTP ${resp.status})`);
    } else if (resp.status === 0) {
      throw new Error('Connection refused');
    }
  } catch (err) {
    console.error(
      `\nPlayground server is not reachable at ${PLAYGROUND_BASE}.\n` +
      'Start the host service first: launchctl kickstart -k gui/$(id -u)/com.nanoclaw\n' +
      `Error: ${String(err)}`,
    );
    process.exit(1);
  }

  // 2. Start fixture server
  console.log(`Starting fixture server on 0.0.0.0:${FIXTURE_PORT} (gateway: ${CONTAINER_HOST_GATEWAY})…`);
  await startFixtureServer();
  console.log(`  Fixture server ready — containers will reach it at http://${CONTAINER_HOST_GATEWAY}:${FIXTURE_PORT}/`);

  let grandTotal = 0;
  let grandPassed = 0;
  const mcpResults: McpResult[] = [];

  try {
    // 3. Obtain session cookie (requires BENCH_MODE=1 on the host)
    console.log('Obtaining bench session cookie…');
    let sessionCookie: string;
    try {
      sessionCookie = await obtainSessionCookie();
      console.log('  Session cookie obtained.');
    } catch (err) {
      console.error(`\nFailed to obtain bench session: ${String(err)}`);
      console.error(
        'The host service must be started with BENCH_MODE=1 in its environment.\n' +
        'For a quick test: BENCH_MODE=1 pnpm run dev  (in a separate terminal)\n' +
        'Or add BENCH_MODE=1 to .env and restart the service.',
      );
      process.exit(1);
    }

    for (const systemKey of systems) {
      console.log(`\nProvisioning bench group for ${systemKey}…`);
      try {
        await provisionBenchGroup(systemKey, source, SYSTEMS[systemKey]!, sessionCookie);
        console.log('  Bench group ready.');
      } catch (err) {
        console.error(`Failed to provision bench group: ${String(err)}`);
        process.exit(1);
      }

      if (suite === 'mcp') {
        const results = await runBenchMcp(source, systemKey, sessionCookie);
        mcpResults.push(...results);
      } else {
        const { total, passed } = await runBench(source, systemKey, reps, sessionCookie);
        grandTotal += total;
        grandPassed += passed;
      }
    }
  } finally {
    // Always stop the fixture server.
    await stopFixtureServer();
    console.log('\nFixture server stopped.');
  }

  if (suite === 'mcp') {
    const totalTasks = mcpResults.length;
    const passedTasks = mcpResults.filter((r) =>
      !r.errored && (r.toolPass && r.answerPass),
    ).length;
    console.log(`\n${systems.length} system${systems.length === 1 ? '' : 's'} · ` +
      `${MCP_TASKS.length} tasks/system · ` +
      `${passedTasks}/${totalTasks} MCP tasks passed`);
    for (const systemKey of systems) {
      const label = SYSTEMS[systemKey]!.label;
      const rows = mcpResults.filter((r) => r.system === label);
      const rowsPassed = rows.filter((r) => !r.errored && r.toolPass && r.answerPass).length;
      console.log(`  ${label}: ${rowsPassed}/${rows.length}`);
    }
  } else {
    const systemCount = systems.length;
    const runsPerSystem = BENCH_PROMPTS.length * reps;
    console.log(
      `\n${systemCount} system${systemCount === 1 ? '' : 's'} · ` +
      `${runsPerSystem} runs/system · ` +
      `${grandPassed}/${grandTotal} programmatic gates passed`,
    );
    console.log('Run `pnpm exec tsx scripts/bench-report.ts` to see the full report.');
  }
}

main().catch((err) => {
  console.error('bench.ts fatal error:', err);
  process.exit(1);
});
