/**
 * Codex app-server JSON-RPC transport primitives.
 *
 * Communicates with `codex app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in codex.ts.
 *
 * Kept separate so the transport can be unit-tested without pulling in the
 * full provider and so any future Codex tooling (e.g. a CLI for manual
 * debugging) can reuse the same primitives.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

/**
 * Errors from `thread/resume` that indicate the thread ID is unusable —
 * typically because the app-server has no memory of it (thread transcript
 * was deleted, server was wiped, ID is from a different codex version).
 * Only errors matching this pattern trigger silent fallback to a fresh
 * thread; everything else bubbles up so the caller can decide what to do.
 *
 * Shared with `codex.ts`'s `isSessionInvalid` to keep the two detection
 * paths in sync.
 */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/**
 * Escape a string for emission inside a TOML basic string (double-quoted).
 * Handles `"` and `\`. Rejects newlines: basic strings can't contain raw
 * newlines, and silently converting them to `\n` would mask misconfiguration
 * (e.g. a secret pasted with a trailing newline). Multiline strings are
 * unsupported for `config.toml` use here.
 */
export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  log(`Spawning: codex ${args.join(' ')}`);
  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCodexAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ── Auto-approval ───────────────────────────────────────────────────────────
// The container sandbox is already the security boundary; inside it, Codex's
// own approval prompts would just block every tool call on a user that isn't
// watching. Accept everything and let sandbox limits do the enforcement.

export function attachCodexAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method}`);

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendCodexResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCodexResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendCodexResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, { input: null });
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

// ── High-level helpers ──────────────────────────────────────────────────────

export async function initializeCodexAppServer(server: AppServer): Promise<void> {
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

export interface ThreadParams {
  model?: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/**
 * Start or resume a Codex thread. If `threadId` is provided, attempts
 * `thread/resume` first and falls back to a fresh `thread/start` on failure
 * (stale thread IDs commonly outlive containers). Returns the active thread
 * ID either way.
 */
export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (threadId) {
    log(`Resuming thread: ${threadId}`);
    const resp = await sendCodexRequest(server, 'thread/resume', {
      threadId,
      ...(params as unknown as Record<string, unknown>),
    });
    if (!resp.error) {
      log(`Thread resumed: ${threadId}`);
      return threadId;
    }
    // Only fall through to fresh-thread on recognized stale-thread errors.
    // Auth, version, or transient failures would otherwise silently discard
    // session state — fail loud instead so the caller can retry or surface.
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
    log(`Stale thread ${threadId}; starting fresh thread.`);
  }

  log('Starting new thread…');
  const resp = await sendCodexRequest(server, 'thread/start', {
    ...(params as unknown as Record<string, unknown>),
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  log(`New thread: ${newThreadId}`);
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  /**
   * Absolute container paths to image files. Each becomes a
   * `local_image` UserInput in codex's turn/start input array; codex
   * base64-encodes the file and forwards it to the upstream model as a
   * multimodal content block. Schema from
   * codex-rs/protocol/src/user_input.rs:UserInput::LocalImage.
   */
  localImagePaths?: string[];
  model?: string;
  cwd?: string;
  /**
   * Reasoning effort for the turn. Maps to codex's `effort` turn/start
   * parameter (low | medium | high). Codex's default is the model's
   * `defaultReasoningEffort` (medium for gpt-5.x), which surfaces real
   * cost as reasoning_output_tokens billed at the output rate. For
   * conversational classroom use 'low' is almost always right — saves
   * hundreds of reasoning tokens per turn on chat-class prompts and the
   * quality loss on short prompts is negligible. Per-group override
   * possible via container.json (future).
   */
  effort?: 'low' | 'medium' | 'high';
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<void> {
  // Images come first in the input array so vision-capable models see them
  // before the text describing what to do with them. Matches the order
  // codex's interactive CLI uses with --image.
  const input: Array<Record<string, unknown>> = [];
  for (const path of params.localImagePaths ?? []) {
    // Wire format is camelCase even though the Rust enum has #[serde(rename_all = "snake_case")]
    // — the deployed codex 0.124.0 protocol uses `localImage` per the error
    // message it returns for unknown variants.
    input.push({ type: 'localImage', path });
  }
  input.push({ type: 'text', text: params.inputText });

  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input,
    model: params.model,
    cwd: params.cwd,
    ...(params.effort ? { effort: params.effort } : {}),
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

// ── Codex config.toml ───────────────────────────────────────────────────────
// Codex reads ~/.codex/config.toml at startup. We rewrite it on every spawn
// to reflect (a) the MCP servers the agent-runner needs and (b) the active
// model_providers block routing codex's outbound HTTP through the credential
// proxy. The two responsibilities share one file, so they're written together
// to avoid the "second writer clobbers the first" trap.
//
// wire_api: codex-app-server ≥ 0.x dropped support for "chat" and requires
// "responses". mlx-omni-server and recent OpenAI-compatible servers support
// the responses API over standard HTTP (no WebSocket required for most paths).

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodexConfigTomlInput {
  /** MCP servers to emit as `[mcp_servers.<name>]` blocks. */
  mcpServers: Record<string, CodexMcpServer>;
  /**
   * Active provider — `codex` (cloud OpenAI via proxy /openai/v1) or `local`
   * (mlx-omni-server via proxy /omlx/v1). Other values fall through to
   * `codex` so unknown providers default to the safer cloud path.
   */
  activeProvider: 'codex' | 'local' | string;
  /** Top-level `model = ...`. Omitted from output when undefined. */
  model: string | undefined;
  /**
   * Credential-proxy base URL (e.g. `http://host.docker.internal:3001`).
   * The `/openai/v1` or `/omlx/v1` suffix is appended based on activeProvider.
   */
  proxyBaseUrl: string;
}

interface ProviderBlockSpec {
  /** TOML table name and codex's `model_provider = "..."` value.
   *  Cannot be the bare `"openai"` — codex reserves that as a built-in
   *  provider ID and refuses to load a config that overrides it. */
  name: 'openai-custom' | 'omlx';
  /** Path suffix added to the proxy base URL. */
  proxyPathSuffix: string;
  /** Container env var carrying the placeholder bearer token. */
  envKey: 'OPENAI_API_KEY' | 'OMLX_API_KEY';
}

function providerBlockSpec(activeProvider: string): ProviderBlockSpec {
  if (activeProvider === 'local') {
    return { name: 'omlx', proxyPathSuffix: '/omlx/v1', envKey: 'OMLX_API_KEY' };
  }
  return { name: 'openai-custom', proxyPathSuffix: '/openai/v1', envKey: 'OPENAI_API_KEY' };
}

export function writeCodexConfigToml(input: CodexConfigTomlInput): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  const lines: string[] = [];

  // 1. Top-level model + model_provider routing.
  // MUST precede all [section] headers — TOML scopes key=value lines to the
  // last opened [section], so any root-level key written after a [section]
  // header silently becomes a property of that section, not the root table.
  const spec = providerBlockSpec(input.activeProvider);
  if (input.model) {
    lines.push(`model = ${tomlBasicString(input.model)}`);
  }
  lines.push(`model_provider = ${tomlBasicString(spec.name)}`);
  lines.push('');

  // 2. MCP servers (preserve existing behavior verbatim).
  for (const [name, config] of Object.entries(input.mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map(tomlBasicString).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value)}`);
      }
    }
    lines.push('');
  }

  // 3. Active model_providers block — only the one for activeProvider.
  const baseUrl = `${input.proxyBaseUrl.replace(/\/+$/, '')}${spec.proxyPathSuffix}`;
  lines.push(`[model_providers.${spec.name}]`);
  lines.push(`name = ${tomlBasicString(spec.name)}`);
  lines.push(`base_url = ${tomlBasicString(baseUrl)}`);
  lines.push('wire_api = "responses"');
  lines.push(`env_key = ${tomlBasicString(spec.envKey)}`);
  lines.push('');

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(
    `Wrote codex config.toml (${Object.keys(input.mcpServers).length} mcp server(s), ` +
      `provider=${spec.name}, model=${input.model ?? '(default)'})`,
  );
}

/** @deprecated — use writeCodexConfigToml. Kept temporarily so any future
 *  out-of-tree caller doesn't break silently. Will be removed once trunk
 *  callers are updated. */
export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  writeCodexConfigToml({
    mcpServers: servers,
    activeProvider: 'codex',
    model: undefined,
    proxyBaseUrl: 'http://host.docker.internal:3001',
  });
}

export function createCodexConfigOverrides(): string[] {
  return ['features.use_linux_sandbox_bwrap=false'];
}
