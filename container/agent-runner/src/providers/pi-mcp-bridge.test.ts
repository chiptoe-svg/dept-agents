import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { createPiHttpMcpBridge, createPiMcpBridge } from './pi-mcp-bridge.js';

describe('createPiMcpBridge', () => {
  let tempDir: string;
  let inboundPath: string;
  let outboundPath: string;
  const mcpServerEntry = path.resolve(import.meta.dir, '../mcp-tools/index.ts');

  beforeEach(() => {
    initTestSessionDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-bridge-'));
    inboundPath = path.join(tempDir, 'inbound.db');
    outboundPath = path.join(tempDir, 'outbound.db');

    const inbound = new Database(inboundPath);
    inbound.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY,
        seq INTEGER UNIQUE,
        channel_type TEXT,
        platform_id TEXT
      );
      CREATE TABLE delivered (
        message_out_id TEXT PRIMARY KEY,
        platform_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'delivered',
        delivered_at TEXT NOT NULL
      );
      CREATE TABLE destinations (
        name TEXT PRIMARY KEY,
        display_name TEXT,
        type TEXT NOT NULL,
        channel_type TEXT,
        platform_id TEXT,
        agent_group_id TEXT
      );
      CREATE TABLE session_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id TEXT,
        thread_id TEXT
      );
      INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
      VALUES ('default', 'Default', 'agent', NULL, NULL, 'ag-default');
    `);
    inbound.close();

    const outbound = new Database(outboundPath);
    outbound.exec(`
      CREATE TABLE messages_out (
        id TEXT PRIMARY KEY,
        seq INTEGER UNIQUE,
        in_reply_to TEXT,
        timestamp TEXT NOT NULL,
        deliver_after TEXT,
        recurrence TEXT,
        kind TEXT NOT NULL,
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT,
        content TEXT NOT NULL
      );
    `);
    outbound.close();
  });

  afterEach(() => {
    closeSessionDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists nanoclaw MCP tools and exposes them as Pi AgentTools', async () => {
    const bridge = await createPiMcpBridge({
      mcpServers: {
        nanoclaw: {
          command: 'bun',
          args: [mcpServerEntry],
          env: {
            SESSION_INBOUND_DB_PATH: inboundPath,
            SESSION_OUTBOUND_DB_PATH: outboundPath,
            SESSION_HEARTBEAT_PATH: path.join(tempDir, '.heartbeat'),
          },
        },
      },
    });

    try {
      const sendMessage = bridge.tools.find((t) => t.name === 'nanoclaw__send_message');
      expect(sendMessage).toBeDefined();
      expect(sendMessage?.label).toContain('send_message');
      expect(sendMessage?.description.length).toBeGreaterThan(0);
    } finally {
      await bridge.close();
    }
  });

  it('executes a bridged MCP tool and returns Pi content/details', async () => {
    const bridge = await createPiMcpBridge({
      mcpServers: {
        nanoclaw: {
          command: 'bun',
          args: [mcpServerEntry],
          env: {
            SESSION_INBOUND_DB_PATH: inboundPath,
            SESSION_OUTBOUND_DB_PATH: outboundPath,
            SESSION_HEARTBEAT_PATH: path.join(tempDir, '.heartbeat'),
          },
        },
      },
    });

    try {
      const tool = bridge.tools.find((t) => t.name === 'nanoclaw__send_message');
      if (!tool) throw new Error('missing bridged send_message tool');

      const result = await tool.execute('toolcall-1', {
        to: 'default',
        text: 'bridge smoke',
      } as never);

      expect(result.content.some((c) => c.type === 'text')).toBe(true);
      expect(result.details).toBeDefined();
      const outbound = new Database(outboundPath, { readonly: true });
      const rows = outbound.prepare('SELECT * FROM messages_out').all();
      outbound.close();
      expect(rows).toHaveLength(1);
    } finally {
      await bridge.close();
    }
  });

  it('connects to host HTTP MCP for nanoclaw and sends the session header', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const seen = {
      url: '',
      headers: {} as Record<string, string>,
      closed: false,
    };
    const bridge = await createPiHttpMcpBridge('http://127.0.0.1:9876/mcp', 'sess-http', {
      createTransport(url, init) {
        seen.url = String(url);
        seen.headers = (init?.requestInit?.headers ?? {}) as Record<string, string>;
        return {
          close: async () => {
            seen.closed = true;
          },
        } as never;
      },
      createClient() {
        return {
          async connect() {},
          async listTools() {
            return {
              tools: [
                {
                  name: 'send_message',
                  description: 'Send a message',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            };
          },
          async callTool(request) {
            calls.push({ name: request.name, args: request.arguments });
            return { content: [{ type: 'text', text: `called ${request.name}` }] };
          },
          async close() {},
        };
      },
    });

    try {
      const tool = bridge.tools.find((t) => t.name === 'nanoclaw__send_message');
      if (!tool) throw new Error('missing bridged send_message tool');

      const result = await tool.execute('toolcall-http', {
        text: 'bridge over http',
      } as never);

      expect(result.content.some((c) => c.type === 'text')).toBe(true);
      expect(calls).toEqual([{ name: 'send_message', args: { text: 'bridge over http' } }]);
      expect(seen.url).toBe('http://127.0.0.1:9876/mcp');
      expect(seen.headers['x-nanoclaw-session']).toBe('sess-http');
    } finally {
      await bridge.close();
      expect(seen.closed).toBe(true);
    }
  });

  it('merges host HTTP nanoclaw tools with stdio MCP servers', async () => {
    const bridge = await createPiMcpBridge({
      hostMcpUrl: 'http://127.0.0.1:9876/mcp',
      sessionId: 'sess-mixed',
      httpBridgeDeps: {
        createTransport() {
          return { close: async () => {} } as never;
        },
        createClient() {
          return {
            async connect() {},
            async listTools() {
              return {
                tools: [
                  {
                    name: 'send_message',
                    description: 'Send a message',
                    inputSchema: {
                      type: 'object',
                      properties: { text: { type: 'string' } },
                      required: ['text'],
                    },
                  },
                ],
              };
            },
            async callTool() {
              return { content: [{ type: 'text', text: 'ok' }] };
            },
            async close() {},
          };
        },
      },
      mcpServers: {
        extra: {
          command: 'bun',
          args: [mcpServerEntry],
          env: {
            SESSION_INBOUND_DB_PATH: inboundPath,
            SESSION_OUTBOUND_DB_PATH: outboundPath,
            SESSION_HEARTBEAT_PATH: path.join(tempDir, '.heartbeat'),
          },
        },
      },
    });

    try {
      expect(bridge.tools.some((t) => t.name === 'nanoclaw__send_message')).toBe(true);
      expect(bridge.tools.some((t) => t.name === 'extra__send_message')).toBe(true);
    } finally {
      await bridge.close();
    }
  });
});
