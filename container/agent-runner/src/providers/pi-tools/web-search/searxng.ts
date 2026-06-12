import type { SearchResult } from './types.js';

const TIMEOUT_MS = 10_000;

interface SearxngResult { title?: string; url?: string; content?: string }
interface SearxngResponse { results?: SearxngResult[] }

export async function searxngSearch(query: string, count: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL;
  if (!base) {
    throw new Error('SEARXNG_URL is not set (SearXNG backend selected but no URL). Set it in the host .env file.');
  }
  const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from SearXNG (is ${base} reachable and JSON enabled?)`);
    }
    const json = (await response.json()) as SearxngResponse;
    const results = json.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: r.title?.trim() || '(no title)',
      url: r.url ?? '(no url)',
      snippet: r.content?.trim() ?? '',
    }));
  } finally {
    clearTimeout(timeout);
  }
}
