import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';

import type { McpServerConfig } from './types.js';
import { resolveHeaders } from './resolve-headers.js';

export interface PiMcpBridge {
  tools: AgentTool[];
  close(): Promise<void>;
}

export interface PiMcpBridgeOptions {
  mcpServers?: Record<string, McpServerConfig>;
  hostMcpUrl?: string;
  sessionId?: string;
  httpBridgeDeps?: PiHttpBridgeDeps;
  /**
   * Container env, used to expand `${VAR}` refs in per-server HTTP headers
   * via `resolveHeaders`. See `mcp-header-env.ts` on the host for how those
   * vars get forwarded into the container in the first place, and the
   * security tradeoff of doing so.
   */
  env?: Record<string, string | undefined>;
}

interface ClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface PiHttpBridgeDeps {
  createTransport: (
    url: URL,
    init: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ) => StreamableHTTPClientTransport;
  createClient: () => ClientLike;
}

const defaultHttpBridgeDeps: PiHttpBridgeDeps = {
  createTransport: (url, init) => new StreamableHTTPClientTransport(url, init),
  createClient: () => new Client({ name: 'nanoclaw-pi-bridge', version: '1.0.0' }),
};

async function loadToolsFromClient(serverName: string, client: ClientLike): Promise<AgentTool[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => mcpToolToPiTool(serverName, tool, client));
}

export async function createPiHttpMcpBridge(
  url: string,
  sessionId: string,
  deps: PiHttpBridgeDeps = defaultHttpBridgeDeps,
): Promise<PiMcpBridge> {
  const transport = deps.createTransport(new URL(url), {
    requestInit: {
      headers: {
        'x-nanoclaw-session': sessionId,
      },
    },
  });
  const client = deps.createClient();
  await client.connect(transport);
  const tools = await loadToolsFromClient('nanoclaw', client);

  return {
    tools,
    async close() {
      await client.close();
      await transport.close();
    },
  };
}

function mcpToolToPiTool(serverName: string, tool: McpTool, client: ClientLike): AgentTool {
  return {
    name: `${serverName}__${tool.name}`,
    label: `${serverName}:${tool.name}`,
    description: tool.description ?? `${tool.name} from ${serverName}`,
    parameters: Type.Unsafe(
      tool.inputSchema ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    ),
    async execute(_toolCallId, params) {
      const result = (await client.callTool({
        name: tool.name,
        arguments: params as Record<string, unknown>,
      })) as Record<string, unknown> & {
        content?: Array<{ type: string; text?: string } & Record<string, unknown>>;
      };
      const content: Array<TextContent | ImageContent> = [];
      for (const item of result.content ?? []) {
        if (item.type === 'text' && typeof item.text === 'string') {
          content.push({ type: 'text', text: item.text });
          continue;
        }
        if (
          item.type === 'image' &&
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string'
        ) {
          content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
        }
      }

      return {
        content,
        details: result,
      };
    },
  };
}

export async function createPiMcpBridge(options: PiMcpBridgeOptions): Promise<PiMcpBridge> {
  const hasHttpNanoclaw = !!(options.hostMcpUrl && options.sessionId);
  const servers = options.mcpServers ?? {};

  if (!hasHttpNanoclaw && Object.keys(servers).length === 0) {
    return { tools: [], close: async () => {} };
  }

  const runtimes: PiMcpBridge[] = [];
  const tools: AgentTool[] = [];

  if (hasHttpNanoclaw) {
    const bridge = await createPiHttpMcpBridge(
      options.hostMcpUrl!,
      options.sessionId!,
      options.httpBridgeDeps ?? defaultHttpBridgeDeps,
    );
    tools.push(...bridge.tools);
    runtimes.push(bridge);
  }

  const httpDeps = options.httpBridgeDeps ?? defaultHttpBridgeDeps;
  for (const [serverName, config] of Object.entries(servers)) {
    if (hasHttpNanoclaw && serverName === 'nanoclaw') continue;

    // Isolate per-server failures: a down or misconfigured third-party MCP
    // server (unreachable, 401, bad URL) must not crash the whole agent
    // turn. Log (server name only — never headers/tokens/URLs that may
    // embed credentials) and skip it; the agent keeps the tools from the
    // servers that did connect.
    try {
      // HTTP transport for operator-configured MCP servers (the common case —
      // see src/container-config.ts on the host for why stdio is now the
      // exception). Headers are resolved from the container env at connect
      // time so persisted config never holds a literal secret.
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      let client: ClientLike;
      if (config.url) {
        transport = httpDeps.createTransport(new URL(config.url), {
          requestInit: { headers: resolveHeaders(config.headers, options.env ?? {}) },
        });
        client = httpDeps.createClient();
      } else {
        transport = new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env: config.env,
        });
        client = new Client({ name: 'nanoclaw-pi-bridge', version: '1.0.0' });
      }

      // client.connect() already enforces the MCP SDK's default 60s request
      // timeout on the initialize handshake (DEFAULT_REQUEST_TIMEOUT_MSEC in
      // @modelcontextprotocol/sdk/shared/protocol.js) — a hung/unreachable
      // server rejects rather than blocking the turn forever, so no
      // additional timeout wrapping is added here.
      await client.connect(transport);
      tools.push(...(await loadToolsFromClient(serverName, client)));
      runtimes.push({
        tools: [],
        async close() {
          await client.close();
          await transport.close();
        },
      });
    } catch (err) {
      console.error(
        `[pi-mcp-bridge] skipping MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()));
    },
  };
}
