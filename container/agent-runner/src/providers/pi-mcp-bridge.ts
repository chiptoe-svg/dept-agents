import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';

import type { McpServerConfig } from './types.js';

export interface PiMcpBridge {
  tools: AgentTool[];
  close(): Promise<void>;
}

export interface PiMcpBridgeOptions {
  mcpServers?: Record<string, McpServerConfig>;
  hostMcpUrl?: string;
  sessionId?: string;
  httpBridgeDeps?: PiHttpBridgeDeps;
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

  for (const [serverName, config] of Object.entries(servers)) {
    if (hasHttpNanoclaw && serverName === 'nanoclaw') continue;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
    const client = new Client({ name: 'nanoclaw-pi-bridge', version: '1.0.0' });
    await client.connect(transport);
    tools.push(...(await loadToolsFromClient(serverName, client)));
    runtimes.push({
      tools: [],
      async close() {
        await client.close();
        await transport.close();
      },
    });
  }

  return {
    tools,
    async close() {
      await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()));
    },
  };
}
