import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

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

/** True if `ip` is loopback / private / link-local / CGNAT / unspecified. */
export function ipIsBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 127) return true; // loopback
    if (p[0] === 10) return true; // RFC1918
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // RFC1918
    if (p[0] === 192 && p[1] === 168) return true; // RFC1918 (incl. the bridge gateway)
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 0) return true; // unspecified
    return false;
  }
  const lower = ip.toLowerCase().split('%')[0]; // drop IPv6 zone id (e.g. fe80::1%eth0)
  if (lower === '::1') return true; // loopback
  // link-local fe80::/10 — the fixed 10-bit prefix spans hex groups
  // 0xfe80-0xfebf, i.e. any of fe8x/fe9x/feax/febx, not just literal "fe80".
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  // IPv4-mapped IPv6, dotted form: ::ffff:192.168.0.1
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return ipIsBlocked(dotted[1]);
  // IPv4-mapped IPv6, hex form: ::ffff:c0a8:1  (URL parser compresses leading zeros)
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipIsBlocked(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  return false;
}

/**
 * Throw if `rawUrl` is not a safe public http(s) target. IP-literal hosts are
 * checked directly (no DNS); hostnames are resolved and ALL addresses checked.
 * Fail-closed: DNS failure or no addresses → throw.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('blocked by egress policy: invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked by egress policy: scheme ${u.protocol} not allowed`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new Error(`blocked by egress policy: DNS resolution failed for ${host}`);
    }
    if (addrs.length === 0) throw new Error(`blocked by egress policy: no addresses for ${host}`);
  }
  for (const a of addrs) {
    if (ipIsBlocked(a)) throw new Error(`blocked by egress policy: internal address ${a}`);
  }
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
        let currentUrl = url;
        let response: Response;
        let redirects = 0;
        for (;;) {
          if (controller.signal.aborted) throw new Error('fetch aborted (timeout)');
          await assertUrlAllowed(currentUrl); // throws on internal/blocked targets
          response = await fetch(currentUrl, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              Accept: 'text/html,text/plain,text/markdown,application/json,*/*',
              'User-Agent': 'Mozilla/5.0 (compatible; NanoclawAgent/1.0)',
            },
          });
          const location = response.headers.get('location');
          if (response.status >= 300 && response.status < 400 && location) {
            if (++redirects > MAX_REDIRECTS) throw new Error('too many redirects');
            currentUrl = new URL(location, currentUrl).toString();
            continue; // re-validate the redirect target on the next loop iteration
          }
          break;
        }

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
