/**
 * web_search — pluggable Pi tool. Dispatches to a backend selected by the
 * WEB_SEARCH_PROVIDER env var (default 'brave'): 'searxng' → self-hosted
 * SearXNG (SEARXNG_URL), anything else → Brave (WEB_SEARCH_API_KEY). The
 * owner picks the backend install-wide; the host forwards WEB_SEARCH_PROVIDER
 * + the backend's config into the container. See the pluggable-web-search spec.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { SearchResult } from './web-search/types.js';
import { braveSearch } from './web-search/brave.js';
import { searxngSearch } from './web-search/searxng.js';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

interface SearchDetails { query: string; count: number; returned: number; provider: string }

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = [`Search results for "${query}":`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function createWebSearchTool(): AgentTool {
  const tool: AgentTool = {
    name: 'web_search',
    label: 'web_search',
    description:
      'Search the web and return ranked results (title, URL, snippet) for a query. Use this to discover URLs you don\'t already know about. Once you have a specific URL, use fetch_url to read its content.',
    parameters: Type.Unsafe({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        count: {
          type: 'number',
          description: `Maximum number of results to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`,
        },
      },
      required: ['query'],
    }),
    async execute(_toolCallId, rawParams): Promise<AgentToolResult<SearchDetails>> {
      const params = rawParams as { query: string; count?: number };
      const query = params.query;
      const count = Math.min(Math.max(1, params.count ?? DEFAULT_COUNT), MAX_COUNT);
      const provider = process.env.WEB_SEARCH_PROVIDER ?? 'brave';
      const backend = provider === 'searxng' ? searxngSearch : braveSearch;
      try {
        const results = await backend(query, count);
        return {
          content: [{ type: 'text', text: formatResults(query, results) }],
          details: { query, count, returned: results.length, provider },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Web search failed: ${message}` }],
          details: { query, count, returned: 0, provider },
        };
      }
    },
  };
  return tool;
}
