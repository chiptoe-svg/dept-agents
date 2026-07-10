import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
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
 * Normalize an IP string for equality comparison: lowercase, strip IPv6 zone
 * ids, and unwrap IPv4-mapped IPv6 (both dotted `::ffff:192.168.0.1` and hex
 * `::ffff:c0a8:1` forms) to plain dotted IPv4.
 */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase().split('%')[0];
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return lower;
}

/**
 * The container gateway (where the credential proxy listens) as the host
 * injected it via `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. Normally the
 * gateway sits inside 192.168/16 and is already blocked structurally by
 * `ipIsBlocked`, but the host honors a `CONTAINER_HOST_GATEWAY` override that
 * could place it outside RFC1918 — this explicit check covers that case.
 * Computed per call: env is fixed for the container's lifetime, and per-call
 * keeps tests able to exercise it.
 */
function gatewayHosts(): { ips: string[]; hostnames: string[] } {
  const ips: string[] = [];
  const hostnames: string[] = [];
  for (const raw of [process.env.ANTHROPIC_BASE_URL, process.env.OPENAI_BASE_URL]) {
    if (!raw) continue;
    try {
      const h = new URL(raw).hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(h)) ips.push(normalizeIp(h));
      else if (h) hostnames.push(h.toLowerCase());
    } catch {
      // Malformed base URL — nothing to add; the structural CIDR checks
      // in ipIsBlocked still apply.
    }
  }
  return { ips, hostnames };
}

/** True if `ip` is the container gateway address (credential proxy host). */
export function isGatewayAddress(ip: string): boolean {
  return gatewayHosts().ips.includes(normalizeIp(ip));
}

function isGatewayHostname(host: string): boolean {
  return gatewayHosts().hostnames.includes(host.toLowerCase());
}

/** Resolver dependency — injectable so tests can simulate DNS rebinding. */
export type LookupFn = (host: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

/**
 * Validate `rawUrl` and return the single vetted IP to connect to.
 *
 * IP-literal hosts are checked directly (no DNS); hostnames are resolved
 * ONCE and ALL addresses checked. Fail-closed: DNS failure or no addresses →
 * throw. The returned address is the pin: callers must connect to exactly
 * this IP (see `safeFetch` / `defaultPinnedFetch`) — re-resolving the
 * hostname at connect time would reopen the DNS-rebinding TOCTOU where a
 * short-TTL record passes validation on one IP and rebinds to the credential
 * proxy's gateway address for the actual connection.
 */
export async function resolvePinnedAddress(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<string> {
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
  if (isGatewayHostname(host)) {
    throw new Error(`blocked by egress policy: host ${host} is the container gateway`);
  }
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await lookupFn(host);
    } catch {
      throw new Error(`blocked by egress policy: DNS resolution failed for ${host}`);
    }
    if (addrs.length === 0) throw new Error(`blocked by egress policy: no addresses for ${host}`);
  }
  for (const a of addrs) {
    if (ipIsBlocked(a)) throw new Error(`blocked by egress policy: internal address ${a}`);
    if (isGatewayAddress(a)) throw new Error(`blocked by egress policy: gateway address ${a}`);
  }
  const pinned = addrs[0];
  // Belt-and-braces: the pin below is what actually gets connected to, so
  // re-check it explicitly even though the loop above already covered it.
  if (ipIsBlocked(pinned) || isGatewayAddress(pinned)) {
    throw new Error(`blocked by egress policy: internal address ${pinned}`);
  }
  return pinned;
}

/**
 * Throw if `rawUrl` is not a safe public http(s) target.
 *
 * NOTE: on its own this is check-then-use — anything that fetches the URL
 * afterwards with a client that re-resolves DNS is vulnerable to rebinding.
 * Use `safeFetch`, which pins the vetted IP into the connection.
 */
export async function assertUrlAllowed(rawUrl: string, lookupFn?: LookupFn): Promise<void> {
  await resolvePinnedAddress(rawUrl, lookupFn);
}

export interface PinnedFetchInit {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Connection dependency: perform one HTTP GET of `url` connecting ONLY to
 * `pinnedIp`. Injectable so tests can observe which IP would be contacted
 * without touching the network.
 */
export type PinnedFetchFn = (
  url: string,
  pinnedIp: string,
  init: PinnedFetchInit,
) => Promise<Response>;

export interface SafeFetchDeps {
  lookup?: LookupFn;
  pinnedFetch?: PinnedFetchFn;
}

/**
 * Default pinned transport: `node:http(s).request` with a `lookup` hook that
 * returns ONLY the pre-vetted IP — the client never consults DNS, so the IP
 * validated is the IP connected to. The URL's hostname is preserved as the
 * Host header and TLS SNI/servername, so virtual hosts and certificate
 * verification (against the HOSTNAME, verification stays ON) keep working.
 *
 * Why not global fetch: Bun's fetch re-resolves the hostname itself and has
 * no lookup/dispatcher hook (it ignores undici dispatchers and aliases the
 * `undici` package to itself), which is exactly the rebinding TOCTOU.
 * Bun honors the node:net/node:tls `lookup` option (verified empirically:
 * pin, Host header, SNI transmission, and lookup-error propagation).
 */
export const defaultPinnedFetch: PinnedFetchFn = (rawUrl, pinnedIp, init) => {
  const u = new URL(rawUrl);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const host = u.hostname.replace(/^\[|\]$/g, '');

  return new Promise<Response>((resolve, reject) => {
    // Connect-time re-check of the pin (belt-and-braces). Runs inside the
    // lookup hook, i.e. after the client has committed to using OUR address
    // instead of DNS — if this hook were ignored by the runtime, requests to
    // un-resolvable hosts would fail with a DNS error rather than connect,
    // and the test asserting this exact message would catch the regression.
    const pinLookup = (
      _hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      if (ipIsBlocked(pinnedIp) || isGatewayAddress(pinnedIp)) {
        callback(new Error(`blocked by egress policy: pinned address ${pinnedIp} refused at connect time`));
        return;
      }
      const family = net.isIPv6(pinnedIp) ? 6 : 4;
      if (options?.all) callback(null, [{ address: pinnedIp, family }]);
      else callback(null, pinnedIp, family);
    };

    const req = mod.request(
      {
        host,
        port: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: init.headers,
        lookup: pinLookup as unknown as net.LookupFunction,
        // SNI must stay the hostname (never the IP) for TLS to verify.
        ...(isHttps && !net.isIP(host) ? { servername: host } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          try {
            const status = res.statusCode ?? 0;
            if (status < 200) {
              reject(new Error(`unexpected HTTP status ${status}`));
              return;
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined) continue;
              if (Array.isArray(v)) for (const item of v) headers.append(k, item);
              else headers.append(k, v);
            }
            const body = Buffer.concat(chunks);
            const noBody =
              status === 204 || status === 205 || status === 304 || body.byteLength === 0;
            resolve(
              new Response(noBody ? null : body, {
                status,
                statusText: res.statusMessage ?? '',
                headers,
              }),
            );
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('fetch aborted (timeout)'));
      } else {
        const onAbort = () => req.destroy(new Error('fetch aborted (timeout)'));
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
    }
    req.end();
  });
};

/**
 * Fetch `rawUrl` with SSRF protection and DNS pinning. Each hop (including
 * every redirect) is resolved ONCE, validated against the egress policy, and
 * then connected to at exactly the vetted IP — the invariant is that the IP
 * validated is the IP connected to. Redirects are followed manually (up to
 * MAX_REDIRECTS) so every hop repeats resolve → validate → pin.
 */
export async function safeFetch(
  rawUrl: string,
  init: PinnedFetchInit = {},
  deps: SafeFetchDeps = {},
): Promise<Response> {
  const doFetch = deps.pinnedFetch ?? defaultPinnedFetch;
  let currentUrl = rawUrl;
  let redirects = 0;
  for (;;) {
    if (init.signal?.aborted) throw new Error('fetch aborted (timeout)');
    const pinnedIp = await resolvePinnedAddress(currentUrl, deps.lookup);
    const response = await doFetch(currentUrl, pinnedIp, init);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (++redirects > MAX_REDIRECTS) throw new Error('too many redirects');
      currentUrl = new URL(location, currentUrl).toString();
      continue; // next hop gets its own resolve → validate → pin
    }
    return response;
  }
}

export function createFetchTool(deps: SafeFetchDeps = {}): AgentTool {
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
        // safeFetch validates each hop (incl. redirects) and pins the vetted
        // IP into the connection — see its docs for the rebinding rationale.
        const response = await safeFetch(
          url,
          {
            signal: controller.signal,
            headers: {
              Accept: 'text/html,text/plain,text/markdown,application/json,*/*',
              'User-Agent': 'Mozilla/5.0 (compatible; NanoclawAgent/1.0)',
            },
          },
          deps,
        );

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
