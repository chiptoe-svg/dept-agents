import { describe, expect, it } from 'bun:test';

import {
  buildMcpBridgeOptions,
  composePiSystemPrompt,
  formatContextUsageMessage,
  getPiReplyErrorMessage,
  piRotationReason,
  routeMidTurnMessage,
  withDeadline,
} from './pi.js';
import type { ProviderOptions } from './types.js';

describe('piRotationReason', () => {
  const now = Date.parse('2026-07-09T00:00:00Z');

  it('rotates a transcript over the size cap (the crash-loop trigger)', () => {
    expect(piRotationReason(3 * 1_048_576, undefined, now)).toMatch(/MB exceeds .* MB resume cap/);
  });

  it('keeps a healthy, recent transcript', () => {
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    expect(piRotationReason(200 * 1024, recent, now)).toBeNull();
  });

  it('rotates a stale session by age even when small', () => {
    const old = new Date(now - 30 * 86_400_000).toISOString();
    expect(piRotationReason(50 * 1024, old, now)).toMatch(/d old exceeds .*d resume cap/);
  });

  it('ignores an unparseable createdAt', () => {
    expect(piRotationReason(50 * 1024, 'not-a-date', now)).toBeNull();
  });
});

describe('getPiReplyErrorMessage', () => {
  it('returns the terminal error message for Pi replies that ended in error', () => {
    const message = {
      content: [{ type: 'text', text: '' }],
      stopReason: 'error',
      errorMessage: 'Failed to refresh OAuth token for openai-codex',
    } as any;

    expect(getPiReplyErrorMessage(message)).toBe('Failed to refresh OAuth token for openai-codex');
  });

  it('returns null for normal replies', () => {
    const message = {
      content: [{ type: 'text', text: '<message to="discord-test">ok</message>' }],
      stopReason: 'stop',
    } as any;

    expect(getPiReplyErrorMessage(message)).toBeNull();
  });

  it('formats context usage as a readable progress message', () => {
    expect(formatContextUsageMessage({ used: 12_450, total: 200_000 })).toBe('Context: 12,450 / 200,000 tokens (6%)');
  });

  it('inlines skills marked with <!-- load: essential --> directly into system prompt', () => {
    const prompt = composePiSystemPrompt('Runtime destinations', [
      {
        name: 'agent-browser',
        description: 'Use when a task needs a browser.',
        content: '<!-- load: essential -->\n\nBROWSER SKILL BODY CONTENT',
        filePath: '/app/skills/agent-browser/SKILL.md',
      },
    ]);

    expect(prompt).toContain('Runtime destinations');
    expect(prompt).toContain('BROWSER SKILL BODY CONTENT');
    // should NOT appear in lazy <available_skills> list since it was inlined
    expect(prompt).not.toContain('<name>agent-browser</name>');
  });

  it('lists skills without the essential marker lazily via available_skills', () => {
    const prompt = composePiSystemPrompt('Runtime destinations', [
      {
        name: 'my-custom-skill',
        description: 'A custom skill.',
        content: 'CUSTOM SKILL BODY',
        filePath: '/workspace/agent/skills/my-custom-skill/SKILL.md',
      },
    ]);

    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>my-custom-skill</name>');
    expect(prompt).not.toContain('CUSTOM SKILL BODY');
  });
});

describe('buildMcpBridgeOptions', () => {
  it('forwards the container env so ${VAR} refs in MCP server headers can be expanded', () => {
    // This is the wiring the pi provider relies on: query() passes
    // this.options.env through to createPiMcpBridge → resolveHeaders. If the
    // env field is dropped, resolveHeaders sees {} and every ${VAR} in a
    // header (e.g. an MCP server's bearer token) is left unexpanded, and
    // the server 401s with no signal anywhere in CI.
    const options: ProviderOptions = {
      mcpServers: {
        wiki: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${WIKI_MCP_TOKEN}' },
        },
      },
      hostMcpUrl: 'http://host.docker.internal:3000/mcp',
      nanoclawSessionId: 'session-123',
      env: { WIKI_MCP_TOKEN: 'test-token-123' },
    };

    const bridgeOptions = buildMcpBridgeOptions(options);

    expect(bridgeOptions.env).toEqual({ WIKI_MCP_TOKEN: 'test-token-123' });
    expect(bridgeOptions.hostMcpUrl).toBe('http://host.docker.internal:3000/mcp');
    expect(bridgeOptions.sessionId).toBe('session-123');
    expect(bridgeOptions.mcpServers).toBe(options.mcpServers);
  });
});

describe('withDeadline', () => {
  it('returns the resolved value when the promise completes before the deadline', async () => {
    const { value, timedOut } = await withDeadline(500, Promise.resolve(42), 0);
    expect(value).toBe(42);
    expect(timedOut).toBe(false);
  });

  it('returns the fallback and timedOut=true when the promise exceeds the deadline', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(99), 300));
    const { value, timedOut } = await withDeadline(50, slow, -1);
    expect(value).toBe(-1);
    expect(timedOut).toBe(true);
  });
});

describe('routeMidTurnMessage', () => {
  function fakeHarness() {
    const calls: string[] = [];
    return {
      calls,
      steer: async (t: string) => {
        calls.push(`steer:${t}`);
      },
      followUp: async (t: string) => {
        calls.push(`followUp:${t}`);
      },
    };
  }

  it('steers when steering is enabled', async () => {
    const h = fakeHarness();
    await routeMidTurnMessage(h, 'redirect now', true);
    expect(h.calls).toEqual(['steer:redirect now']);
  });

  it('follows up (after-turn) when steering is disabled', async () => {
    const h = fakeHarness();
    await routeMidTurnMessage(h, 'later', false);
    expect(h.calls).toEqual(['followUp:later']);
  });

  it('falls back to followUp when steer() rejects (never lossy)', async () => {
    const calls: string[] = [];
    const h = {
      calls,
      steer: async () => {
        throw new Error('harness busy');
      },
      followUp: async (t: string) => {
        calls.push(`followUp:${t}`);
      },
    };
    await routeMidTurnMessage(h, 'redirect', true);
    expect(calls).toEqual(['followUp:redirect']);
  });

  it('does not reject when followUp throws (steering disabled)', async () => {
    const h = {
      steer: async () => {},
      followUp: async () => {
        throw new Error('followUp down');
      },
    };
    await expect(routeMidTurnMessage(h, 'x', false)).resolves.toBeUndefined();
  });

  it('does not reject when both steer and the fallback followUp throw', async () => {
    const h = {
      steer: async () => {
        throw new Error('steer down');
      },
      followUp: async () => {
        throw new Error('followUp down too');
      },
    };
    await expect(routeMidTurnMessage(h, 'x', true)).resolves.toBeUndefined();
  });
});
