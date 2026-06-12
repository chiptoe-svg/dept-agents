import type { SearchResult } from './types.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TIMEOUT_MS = 10_000;

interface BraveResult { title?: string; url?: string; description?: string }
interface BraveResponse { web?: { results?: BraveResult[] } }

export async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const apiKey = process.env.WEB_SEARCH_API_KEY ?? '';
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    if (!response.ok) {
      const hint =
        response.status === 401
          ? ' (WEB_SEARCH_API_KEY is missing or invalid. Set it in the host .env file.)'
          : '';
      throw new Error(`HTTP ${response.status} ${response.statusText}${hint}`);
    }
    const json = (await response.json()) as BraveResponse;
    const results = json.web?.results ?? [];
    return results.slice(0, count).map((r) => ({
      title: r.title?.trim() || '(no title)',
      url: r.url ?? '(no url)',
      snippet: r.description?.trim() ?? '',
    }));
  } finally {
    clearTimeout(timeout);
  }
}
