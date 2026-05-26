import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_WORDS = 3_000;
const MAX_CACHE_ENTRIES = 50;
const MAX_REDIRECTS = 5;

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

interface FetchDetails {
  url: string;
  contentType: string;
  truncated: boolean;
}

function htmlToText(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '');
  // Block-level elements → newline
  text = text.replace(
    /<\/?(p|div|h[1-6]|li|tr|br|article|section|header|footer|nav|main|blockquote)[^>]*>/gi,
    '\n',
  );
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, ' ');
  // Normalise whitespace
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function truncate(
  text: string,
  maxWords: number,
): { text: string; truncated: boolean; remaining: number } {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return { text, truncated: false, remaining: 0 };
  const remaining = words.length - maxWords;
  return { text: words.slice(0, maxWords).join(' '), truncated: true, remaining };
}

function textResult(
  text: string,
  maxWords: number,
  details: FetchDetails,
): AgentToolResult<FetchDetails> {
  const { text: out, truncated, remaining } = truncate(text, maxWords);
  const finalText = truncated ? `${out}\n\n[truncated — ${remaining} words omitted]` : out;
  return { content: [{ type: 'text', text: finalText }], details: { ...details, truncated } };
}

export function createFetchTool(): AgentTool {
  const cache = new Map<string, CacheEntry>();

  const tool: AgentTool = {
    name: 'fetch_url',
    label: 'fetch_url',
    description:
      'Fetch a URL and return its text content. Use this first for any task that needs to read a web page at a known URL. Use agent-browser instead when the page requires login, JavaScript interaction, or form submission.',
    parameters: Type.Unsafe({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        maxWords: {
          type: 'number',
          description: `Maximum words to return (default: ${DEFAULT_MAX_WORDS})`,
        },
      },
      required: ['url'],
    }),
    async execute(_toolCallId, rawParams): Promise<AgentToolResult<FetchDetails>> {
      const params = rawParams as { url: string; maxWords?: number };
      const { url, maxWords = DEFAULT_MAX_WORDS } = params;

      // Serve from cache when fresh
      const cached = cache.get(url);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return textResult(cached.content, maxWords, { url, contentType: 'cached', truncated: false });
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            Accept: 'text/html,text/plain,text/markdown,application/json,*/*',
            'User-Agent': 'Mozilla/5.0 (compatible; NanoclawAgent/1.0)',
          },
        });

        if (!response.ok) {
          const msg = `Fetch failed: HTTP ${response.status} ${response.statusText}`;
          return { content: [{ type: 'text', text: msg }], details: { url, contentType: 'error', truncated: false } };
        }

        const contentType = response.headers.get('content-type') ?? '';
        let text: string;

        if (contentType.includes('application/json')) {
          const json = (await response.json()) as unknown;
          text = JSON.stringify(json, null, 2);
        } else if (contentType.includes('text/html')) {
          text = htmlToText(await response.text());
        } else if (contentType.includes('text/') || contentType.includes('application/xml')) {
          text = await response.text();
        } else {
          const msg = `Content type "${contentType}" not supported — use agent-browser for this URL`;
          return { content: [{ type: 'text', text: msg }], details: { url, contentType, truncated: false } };
        }

        // Cache and evict oldest entry if over the limit
        cache.set(url, { content: text, fetchedAt: Date.now() });
        if (cache.size > MAX_CACHE_ENTRIES) {
          const oldest = [...cache.entries()].reduce((a, b) =>
            a[1].fetchedAt < b[1].fetchedAt ? a : b,
          );
          cache.delete(oldest[0]);
        }

        return textResult(text, maxWords, { url, contentType, truncated: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Fetch failed: ${message}` }],
          details: { url, contentType: 'error', truncated: false },
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
  };

  return tool;
}
