/**
 * Per-call attribution wrapper unit tests. Bun runtime — uses bun:test
 * because container/agent-runner/ depends on bun:sqlite elsewhere; vitest
 * isn't an option in this tree.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installProxyFetch } from './proxy-fetch.js';

const HEADER_NAME = 'X-NanoClaw-Agent-Group';
const PROXY_ORIGIN = 'http://host.docker.internal:3001';

function captureHeaders(): { calls: Array<{ url: string; headers: Headers }>; reset: () => void } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    calls.push({ url, headers });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  return { calls, reset: () => (globalThis.fetch = original) };
}

describe('installProxyFetch', () => {
  let originalAgentGroup: string | undefined;
  let originalAnthropic: string | undefined;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    originalAgentGroup = process.env.X_NANOCLAW_AGENT_GROUP;
    originalAnthropic = process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
    if (originalAgentGroup === undefined) delete process.env.X_NANOCLAW_AGENT_GROUP;
    else process.env.X_NANOCLAW_AGENT_GROUP = originalAgentGroup;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropic;
  });

  test('adds X-NanoClaw-Agent-Group header to proxy requests', async () => {
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
    process.env.ANTHROPIC_BASE_URL = PROXY_ORIGIN;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    await fetch(`${PROXY_ORIGIN}/v1/messages`);

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBe('ag_test_42');
  });

  test('does NOT add the header to non-proxy requests', async () => {
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
    process.env.ANTHROPIC_BASE_URL = PROXY_ORIGIN;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    await fetch('https://example.com/something');

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBeNull();
  });

  test('no-op when X_NANOCLAW_AGENT_GROUP is unset', async () => {
    delete process.env.X_NANOCLAW_AGENT_GROUP;
    process.env.ANTHROPIC_BASE_URL = PROXY_ORIGIN;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    await fetch(`${PROXY_ORIGIN}/v1/messages`);

    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBeNull();
  });

  test('no-op when no proxy origin is in env', async () => {
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    await fetch(`${PROXY_ORIGIN}/v1/messages`);

    // No origin to match against → wrapper is a no-op even for proxy URLs.
    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBeNull();
  });

  test('preserves a caller-supplied header value (does not overwrite)', async () => {
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_default';
    process.env.ANTHROPIC_BASE_URL = PROXY_ORIGIN;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    await fetch(`${PROXY_ORIGIN}/v1/messages`, { headers: { [HEADER_NAME]: 'ag_caller_set' } });

    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBe('ag_caller_set');
  });

  test('idempotent: calling installProxyFetch twice does not double-wrap', async () => {
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
    process.env.ANTHROPIC_BASE_URL = PROXY_ORIGIN;
    const cap = captureHeaders();
    restoreFetch = cap.reset;

    installProxyFetch();
    installProxyFetch();
    await fetch(`${PROXY_ORIGIN}/v1/messages`);

    // One call, header set once. (Double-wrap would still produce one
    // header, but the wrapper would chain through itself — the marker
    // check prevents that.)
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.headers.get(HEADER_NAME)).toBe('ag_test_42');
  });
});
