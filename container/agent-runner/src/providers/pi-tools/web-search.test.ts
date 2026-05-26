/**
 * Tests for createWebSearchTool — the Pi-only web_search tool.
 *
 * In this classroom install there is no OneCLI HTTPS_PROXY gateway.
 * The tool sends X-Subscription-Token directly from WEB_SEARCH_API_KEY.
 * These tests verify the request shape (including the auth header),
 * response parsing, and error surfaces.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

import { createWebSearchTool } from './web-search.js';

const REAL_FETCH = globalThis.fetch;
let fetchCalls: { url: string; init: RequestInit | undefined }[] = [];

function mockFetchOnce(response: Response): void {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('createWebSearchTool', () => {
  it('exposes the expected AgentTool shape', () => {
    const tool = createWebSearchTool();
    expect(tool.name).toBe('web_search');
    expect(tool.description?.toLowerCase()).toContain('search');
    expect(tool.execute).toBeDefined();
  });

  it('calls Brave Search with the query in the URL', async () => {
    mockFetchOnce(jsonResponse({ web: { results: [] } }));
    const tool = createWebSearchTool();
    await tool.execute('test-call-1', { query: 'how does HTTPS work' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('api.search.brave.com');
    // encodeURIComponent uses %20 for spaces (both %20 and + are valid in queries).
    expect(fetchCalls[0].url).toContain('q=how%20does%20HTTPS%20work');
  });

  it('sends X-Subscription-Token from WEB_SEARCH_API_KEY env var', async () => {
    const savedKey = process.env.WEB_SEARCH_API_KEY;
    process.env.WEB_SEARCH_API_KEY = 'test-api-key-123';
    try {
      mockFetchOnce(jsonResponse({ web: { results: [] } }));
      const tool = createWebSearchTool();
      await tool.execute('test-call-2', { query: 'anything' });

      const headers = fetchCalls[0].init?.headers as Record<string, string> | undefined;
      // No OneCLI gateway in this install — the tool sends the header directly.
      expect(headers?.['X-Subscription-Token']).toBe('test-api-key-123');
    } finally {
      if (savedKey === undefined) delete process.env.WEB_SEARCH_API_KEY;
      else process.env.WEB_SEARCH_API_KEY = savedKey;
    }
  });

  it('renders results as a numbered list of title + url + snippet', async () => {
    mockFetchOnce(
      jsonResponse({
        web: {
          results: [
            {
              title: 'How TLS works',
              url: 'https://example.com/tls',
              description: 'A brief explanation of TLS handshake.',
            },
            {
              title: 'HTTPS basics',
              url: 'https://example.com/https',
              description: 'TLS over HTTP for transport security.',
            },
          ],
        },
      }),
    );

    const tool = createWebSearchTool();
    const result = await tool.execute('test-call-3', { query: 'TLS' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(text).toContain('How TLS works');
    expect(text).toContain('https://example.com/tls');
    expect(text).toContain('A brief explanation of TLS handshake.');
    expect(text).toContain('HTTPS basics');
  });

  it('honors the count parameter (capped to API maximum)', async () => {
    mockFetchOnce(jsonResponse({ web: { results: [] } }));
    const tool = createWebSearchTool();
    await tool.execute('test-call-4', { query: 'x', count: 5 });

    expect(fetchCalls[0].url).toContain('count=5');
  });

  it('caps count at 20 (Brave API limit)', async () => {
    mockFetchOnce(jsonResponse({ web: { results: [] } }));
    const tool = createWebSearchTool();
    await tool.execute('test-call-5', { query: 'x', count: 100 });

    expect(fetchCalls[0].url).toContain('count=20');
  });

  it('handles empty result sets cleanly', async () => {
    mockFetchOnce(jsonResponse({ web: { results: [] } }));
    const tool = createWebSearchTool();
    const result = await tool.execute('test-call-6', { query: 'no hits' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/no results|no matches|0 results/i);
  });

  it('surfaces a hint about WEB_SEARCH_API_KEY on 401', async () => {
    mockFetchOnce(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );
    const tool = createWebSearchTool();
    const result = await tool.execute('test-call-7', { query: 'x' });
    const text = (result.content[0] as { text: string }).text;
    // Generic HTTP error info + env-var hint specifically for 401.
    expect(text).toMatch(/401/);
    expect(text).toContain('WEB_SEARCH_API_KEY');
    expect(text).toContain('.env');
  });

  it('surfaces other HTTP errors without the env-var hint', async () => {
    mockFetchOnce(
      new Response('Internal Server Error', { status: 500, statusText: 'Server Error' }),
    );
    const tool = createWebSearchTool();
    const result = await tool.execute('test-call-8', { query: 'x' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/500/);
    // No credential hint for non-auth failures — would mislead users.
    expect(text).not.toContain('WEB_SEARCH_API_KEY');
  });

  it('handles missing optional fields in results', async () => {
    mockFetchOnce(
      jsonResponse({
        web: {
          results: [
            { title: 'Just a title', url: 'https://example.com/a' },
            { url: 'https://example.com/b', description: 'No title' },
            { title: 'Snippetless', url: 'https://example.com/c' },
          ],
        },
      }),
    );
    const tool = createWebSearchTool();
    const result = await tool.execute('test-call-9', { query: 'x' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('https://example.com/b');
    expect(text).toContain('https://example.com/c');
  });
});
