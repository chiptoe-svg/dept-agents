/**
 * web_search — Pi-only tool that gives Pi web search capability. Pi agents
 * ship with fetch but no built-in search, so this closes that gap.
 *
 * Backed by the Brave Search API. Unlike the personal/OneCLI install, this
 * classroom version uses no HTTPS_PROXY gateway — the credential-proxy is
 * path-prefix-based (/openai/, etc.) and does not intercept requests to
 * api.search.brave.com. The tool therefore sends the `X-Subscription-Token`
 * header directly, sourced from the `WEB_SEARCH_API_KEY` env var on the host.
 *
 * To add or rotate the key:
 *   Set WEB_SEARCH_API_KEY=<your-brave-api-key> in the host's .env file.
 *
 * A 401 from Brave means WEB_SEARCH_API_KEY is missing, wrong, or revoked —
 * the tool surfaces a hint pointing the user there.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20; // Brave API hard limit
const TIMEOUT_MS = 10_000;

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
}

interface SearchDetails {
  query: string;
  count: number;
  returned: number;
}

function formatResults(query: string, results: BraveResult[]): string {
  if (results.length === 0) {
    return `No results for "${query}".`;
  }
  const lines = [`Search results for "${query}":`, ''];
  results.forEach((r, i) => {
    const title = r.title?.trim() || '(no title)';
    const url = r.url ?? '(no url)';
    const snippet = r.description?.trim();
    lines.push(`${i + 1}. **${title}**`);
    lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
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

      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        // Send X-Subscription-Token directly — there is no OneCLI HTTPS_PROXY
        // gateway in this install. The credential-proxy only intercepts
        // /openai/ and /anthropic/ prefixed paths; Brave requests go direct.
        const apiKey = process.env.WEB_SEARCH_API_KEY ?? '';
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        });

        if (!response.ok) {
          // 401 means WEB_SEARCH_API_KEY is missing, wrong, or revoked.
          const hint =
            response.status === 401
              ? ' (WEB_SEARCH_API_KEY is missing or invalid. Set it in the host .env file.)'
              : '';
          return {
            content: [
              {
                type: 'text',
                text: `Web search failed: HTTP ${response.status} ${response.statusText}${hint}`,
              },
            ],
            details: { query, count, returned: 0 },
          };
        }

        const json = (await response.json()) as BraveResponse;
        const results = json.web?.results ?? [];
        return {
          content: [{ type: 'text', text: formatResults(query, results) }],
          details: { query, count, returned: results.length },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Web search failed: ${message}` }],
          details: { query, count, returned: 0 },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  return tool;
}
