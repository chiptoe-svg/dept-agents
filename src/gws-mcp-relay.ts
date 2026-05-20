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
 *   - X-NanoClaw-Agent-Group header is required on POST /tools/<name>.
 *     401 if missing. Same primitive the credential proxy added in this
 *     branch.
 *   - The header value must resolve to an existing agent group. 401 if
 *     the agent group ID is unknown.
 *
 * Bound to loopback by default. The container-side stub reaches us via
 * `host.docker.internal:GWS_MCP_RELAY_PORT` (same gateway pattern as
 * the credential proxy).
 *
 * Per-student GWS isolation comes for free: `dispatchTool` calls into
 * `gws-mcp-tools.ts`, which resolves its OAuth token via
 * `getGoogleAccessTokenForAgentGroup(agentGroupId)`. Per-student
 * credentials are picked up automatically when present; instructor's
 * token used as fallback.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { GWS_MCP_RELAY_PORT } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { dispatchTool, listToolNames } from './gws-mcp-server.js';
import { log } from './log.js';

const AGENT_GROUP_HEADER = 'x-nanoclaw-agent-group';

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

function readAgentGroupHeader(req: IncomingMessage): string | null {
  const raw = req.headers[AGENT_GROUP_HEADER];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
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

    const agentGroupId = readAgentGroupHeader(req);
    if (!agentGroupId) {
      return send(res, 401, {
        ok: false,
        error:
          'Missing X-NanoClaw-Agent-Group header. Container-side proxy-fetch wrapper should set this automatically.',
      });
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
