/**
 * fetch_url_to_workspace — download a URL and save it under /workspace/agent/.
 *
 * Ported from the personal repo's mcp-tools/files.ts, but that version's
 * "guard" was actually an ALLOWLIST of exactly two internal hosts (the
 * container bridge gateway + host.docker.internal) — the opposite of what
 * this repo needs. Here the credential proxy and GWS MCP relay listen ON
 * the bridge gateway (Plan 1.5), so a tool that lets a confused/injected
 * agent request that gateway is the SSRF hole, not the fix. This version
 * uses a blocklist instead: any public http(s) URL is allowed, and the
 * bridge gateway / loopback / link-local / RFC1918 ranges are refused —
 * structurally, via CIDR checks, not by hardcoding the current gateway IP.
 *
 * Reuses the SSRF guard (`assertUrlAllowed`) from `../tools/fetch.ts` (the
 * `fetch_url` tool) rather than re-implementing it, so both tools share one
 * hardened, tested implementation.
 */
import fs from 'fs';
import path from 'path';

import { assertUrlAllowed } from '../tools/fetch.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const WORKSPACE = '/workspace/agent';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(WORKSPACE, p);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const fetchUrlToWorkspace: McpToolDefinition = {
  tool: {
    name: 'fetch_url_to_workspace',
    description:
      'Download a URL and save the response body to /workspace/agent/. Returns the saved path for use with send_file. Use this to materialize images or files from MCP tool photo_url fields so they can be delivered via send_file. Only public http(s) URLs are allowed — internal/private network targets are refused.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch (must be a public http/https URL)' },
        filename: { type: 'string', description: 'Filename to save as under /workspace/agent/ (e.g. "john_doe.jpg")' },
      },
      required: ['url', 'filename'],
    },
  },
  async handler(args) {
    const url = args.url as string;
    const filename = args.filename as string;
    if (!url) return err('url is required');
    if (!filename) return err('filename is required');

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      let currentUrl = url;
      let response: Response;
      let redirects = 0;
      for (;;) {
        // Re-validated on every hop — a permitted URL that redirects to an
        // internal address must not be followed blindly.
        await assertUrlAllowed(currentUrl);
        response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          if (++redirects > MAX_REDIRECTS) return err('too many redirects');
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        break;
      }

      if (!response.ok) return err(`Fetch failed: ${response.status} ${response.statusText}`);

      const buffer = await response.arrayBuffer();
      const filePath = resolvePath(filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(buffer));

      return ok(`Saved ${buffer.byteLength} bytes to ${filePath}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
};

registerTools([fetchUrlToWorkspace]);
