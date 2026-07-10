/**
 * GWS MCP relay — host-side HTTP listener that fronts `gws-mcp-server.ts`.
 *
 * The relay's job is to authenticate the calling agent group, then
 * dispatch into the in-process tool registry. It does NOT speak the
 * full MCP / JSON-RPC protocol — agents reach us via the container-
 * side stub (Phase 13.4) which translates MCP stdio ↔ HTTP. This
 * keeps the relay shape simple: one POST per tool call, JSON in / JSON
 * out, status code reflects the tool result.
 *
 * Endpoints:
 *   GET  /tools                    list tool names — health/discovery
 *   POST /tools/<name>             invoke a tool; body is the args object
 *
 * Auth:
 *   - X-NanoClaw-Agent-Token header is required on POST /tools/<name>.
 *     401 if missing, empty, unknown, or array-valued. The agent group is
 *     derived server-side from the token (see resolveRelayIdentity) — the
 *     container-set X-NanoClaw-Agent-Group header is never trusted for
 *     identity, since any container can set it to another user's group id.
 *     Same primitive the credential proxy uses (Task 5, C5).
 *   - The token-derived group id must resolve to an existing agent group.
 *     401 if the agent group ID is unknown.
 *
 * Despite the module-level "loopback only" framing in older comments, this
 * process binds to PROXY_BIND_HOST (often 0.0.0.0 on multi-host setups),
 * so the token check above is the actual security boundary, not the bind
 * address.
 *
 * The container-side stub reaches us via `host.docker.internal:GWS_MCP_RELAY_PORT`
 * (same gateway pattern as the credential proxy).
 *
 * Per-group GWS isolation is a hard requirement, not best-effort:
 * `dispatchTool` calls into `gws-mcp-tools.ts`, which resolves its OAuth
 * token via `getGoogleAccessTokenForAgentGroup(agentGroupId)` — the
 * calling group's OWN token, or `null`. There is no owner/instructor
 * fallback; a group with no personal Google credentials gets a clear
 * "connect your Google account" error, never another group's data.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { GWS_MCP_RELAY_PORT } from './config.js';
import { resolveContainerToken } from './container-identity.js';
import { getAgentGroup } from './db/agent-groups.js';
import { dispatchTool, listToolNames } from './gws-mcp-server.js';
import { log } from './log.js';

const AGENT_TOKEN_HEADER = 'x-nanoclaw-agent-token';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * The calling container's agent group, derived from its per-container token.
 * The `x-nanoclaw-agent-group` header is NOT trusted: the container sets it
 * itself, so honoring it let any agent operate on any other user's Google
 * account. Exported for tests.
 */
export function resolveRelayIdentity(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[AGENT_TOKEN_HEADER];
  const token = typeof raw === 'string' ? raw : null;
  return resolveContainerToken(token)?.agentGroupId ?? null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';

  if (method === 'GET' && url.pathname === '/tools') {
    return send(res, 200, { tools: listToolNames() });
  }

  const toolMatch = url.pathname.match(/^\/tools\/([a-z_][a-z0-9_]*)$/);
  if (method === 'POST' && toolMatch) {
    const toolName = toolMatch[1]!;

    const agentGroupId = resolveRelayIdentity(req.headers);
    if (!agentGroupId) {
      return send(res, 401, { ok: false, error: 'Missing or invalid X-NanoClaw-Agent-Token.' });
    }
    const group = getAgentGroup(agentGroupId);
    if (!group) {
      return send(res, 401, { ok: false, error: `Unknown agent_group_id: ${agentGroupId}` });
    }

    let args: unknown;
    try {
      args = await readJson(req);
    } catch (err) {
      return send(res, 400, { ok: false, error: `Body must be JSON: ${(err as Error).message}` });
    }

    const result = await dispatchTool({
      ctx: { agentGroupId },
      toolName,
      args,
    });
    const status = result.ok ? 200 : 'status' in result && typeof result.status === 'number' ? result.status : 500;
    return send(res, status, result);
  }

  return send(res, 404, { ok: false, error: `No route: ${method} ${url.pathname}` });
}

let server: Server | null = null;

export function startGwsMcpRelay(host = '127.0.0.1'): Promise<Server> {
  if (server) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        log.error('GWS MCP relay request error', { err: String(err) });
        if (!res.headersSent) {
          send(res, 500, { ok: false, error: String(err) });
        }
      });
    });
    s.on('error', (err) => {
      log.error('GWS MCP relay server error', { err: String(err) });
      reject(err);
    });
    s.listen(GWS_MCP_RELAY_PORT, host, () => {
      server = s;
      log.info('GWS MCP relay started', { host, port: GWS_MCP_RELAY_PORT });
      resolve(s);
    });
  });
}

export async function stopGwsMcpRelay(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  log.info('GWS MCP relay stopped');
}
