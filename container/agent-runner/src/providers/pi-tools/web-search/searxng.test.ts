import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { searxngSearch } from './searxng.js';

const REAL_FETCH = globalThis.fetch;
let fetchCalls: string[] = [];
function mockFetchOnce(response: Response): void {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    fetchCalls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return response;
  }) as unknown as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { fetchCalls = []; process.env.SEARXNG_URL = 'http://searxng.test:8888'; });
afterEach(() => { globalThis.fetch = REAL_FETCH; delete process.env.SEARXNG_URL; });

describe('searxngSearch', () => {
  it('hits SEARXNG_URL /search with format=json and maps fields', async () => {
    mockFetchOnce(jsonResponse({ results: [
      { title: 'Paris weather', url: 'https://w.com/paris', content: '73F partly cloudy', engine: 'google' },
    ] }));
    const out = await searxngSearch('weather paris', 5);
    expect(fetchCalls[0]).toContain('http://searxng.test:8888/search');
    expect(fetchCalls[0]).toContain('format=json');
    expect(fetchCalls[0]).toContain('q=weather%20paris');
    expect(out).toEqual([{ title: 'Paris weather', url: 'https://w.com/paris', snippet: '73F partly cloudy' }]);
  });
  it('respects count', async () => {
    mockFetchOnce(jsonResponse({ results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, content: `c${i}` })) }));
    const out = await searxngSearch('q', 3);
    expect(out).toHaveLength(3);
  });
  it('throws when SEARXNG_URL is unset', async () => {
    delete process.env.SEARXNG_URL;
    await expect(searxngSearch('q', 5)).rejects.toThrow(/SEARXNG_URL/);
  });
  it('throws on non-200', async () => {
    mockFetchOnce(jsonResponse({}, 502));
    await expect(searxngSearch('q', 5)).rejects.toThrow(/502/);
  });
});
