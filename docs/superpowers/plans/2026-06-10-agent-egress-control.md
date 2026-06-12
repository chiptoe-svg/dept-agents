# Agent Egress Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a prompt-injected agent from using the org's real credentials against arbitrary upstream API endpoints (via the credential proxy) and from reaching internal services (via `fetch_url`).

**Architecture:** Three layers, all fail-closed. (1) `fetch_url` rejects internal/loopback/link-local/CGNAT IPs and re-validates redirects. (2) The credential proxy routes every provider by explicit prefix — including a new `/anthropic` prefix — with no catch-all (unrecognized → 403). (3) A per-route path allowlist permits only the specific LLM endpoints (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`); `/googleapis` gets an empty allowlist (it has no legitimate caller) and everything else → 403 with no credential injected.

**Tech Stack:** Node host (`src/`, vitest, better-sqlite3), Bun agent-runner (`container/agent-runner/src/`, bun:test). The proxy is plain Node `http`. `fetch_url` runs in Bun (supports `node:dns/promises`, `node:net`).

**Spec:** `docs/superpowers/specs/2026-06-10-agent-egress-control-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `container/agent-runner/src/tools/fetch.ts` | `fetch_url` tool | Add URL egress guard + manual redirect re-validation |
| `container/agent-runner/src/tools/fetch.test.ts` | tests | Create |
| `src/credential-proxy.ts` | route resolution + per-route allowlist + cred injection | Add `/anthropic` route, drop catch-all, add allowlist gate; expose pure helpers |
| `src/credential-proxy.test.ts` | tests | Add route/allowlist unit tests (create if absent) |
| `src/container-runner.ts` | container env injection | `ANTHROPIC_BASE_URL` gains `/anthropic` prefix |

---

## Task 1: `fetch_url` egress guard (agent-runner)

**Files:**
- Modify: `container/agent-runner/src/tools/fetch.ts`
- Test: `container/agent-runner/src/tools/fetch.test.ts` (create)

Run all tests in this task with: `cd container/agent-runner && bun test src/tools/fetch.test.ts`

- [ ] **Step 1: Write failing tests for the pure IP classifier + URL guard**

Create `container/agent-runner/src/tools/fetch.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test';
import { ipIsBlocked, assertUrlAllowed } from './fetch.js';

describe('ipIsBlocked', () => {
  it('blocks loopback, RFC1918, link-local, CGNAT, unspecified', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1',
                       '192.168.64.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(ipIsBlocked(ip)).toBe(true);
    }
  });
  it('blocks IPv6 loopback, ULA, link-local, and IPv4-mapped private', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1']) {
      expect(ipIsBlocked(ip)).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) {
      expect(ipIsBlocked(ip)).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(assertUrlAllowed('ftp://x/y')).rejects.toThrow(/scheme/);
  });
  it('rejects IP-literal internal hosts without any DNS lookup', async () => {
    await expect(assertUrlAllowed('http://192.168.64.1:3001/openai/v1/models')).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed('http://127.0.0.1:8888/')).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed('http://169.254.169.254/')).rejects.toThrow(/blocked/);
  });
  it('allows a public IP-literal host', async () => {
    await expect(assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
  });
  it('fails closed when DNS does not resolve (RFC 6761 .invalid never resolves)', async () => {
    await expect(assertUrlAllowed('http://nonexistent.invalid/')).rejects.toThrow(/DNS resolution failed/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd container/agent-runner && bun test src/tools/fetch.test.ts`
Expected: FAIL — `ipIsBlocked`/`assertUrlAllowed` are not exported.

- [ ] **Step 3: Implement the guard helpers in `fetch.ts`**

At the top of `container/agent-runner/src/tools/fetch.ts`, add imports after the existing imports (lines 1–2):

```ts
import { lookup } from 'node:dns/promises';
import net from 'node:net';
```

Add these exported functions above `export function createFetchTool()` (after the `textResult` helper, ~line 65):

```ts
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
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipIsBlocked(mapped[1]);
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd container/agent-runner && bun test src/tools/fetch.test.ts`
Expected: PASS (all of Step 1's tests).

- [ ] **Step 5: Wire the guard + manual redirect re-validation into `execute()`**

In `fetch.ts`, replace the single fetch call block (current lines ~96–112, from `const controller = new AbortController();` through the `if (!response.ok)` block) so the guard runs first and redirects are followed manually with re-validation. Replace:

```ts
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
```

with:

```ts
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        let currentUrl = url;
        let response: Response;
        let redirects = 0;
        for (;;) {
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
```

(The existing `catch (err)` block already returns `Fetch failed: ${message}`, which surfaces the `blocked by egress policy: …` message to the agent. `MAX_REDIRECTS` is now used, resolving its previously-dead state.)

- [ ] **Step 6: Add a redirect-revalidation test**

Append to `fetch.test.ts`:

```ts
describe('fetch_url redirect re-validation', () => {
  it('blocks a redirect that points at an internal IP', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(null, { status: 302, headers: { location: 'http://192.168.64.1:3001/openai/v1/models' } }),
    ) as unknown as typeof fetch;
    try {
      const { createFetchTool } = await import('./fetch.js');
      const tool = createFetchTool();
      const res = await tool.execute('id', { url: 'https://example.com/redirect' });
      const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
      expect(text).toMatch(/blocked by egress policy/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
```

- [ ] **Step 7: Run the full agent-runner test + typecheck**

Run: `cd container/agent-runner && bun test src/tools/fetch.test.ts && bun run typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/tools/fetch.ts container/agent-runner/src/tools/fetch.test.ts
git commit -m "feat(fetch_url): block internal/loopback/link-local egress + re-validate redirects"
```

---

## Task 2: Explicit-prefix proxy routing with no catch-all (host)

**Files:**
- Modify: `src/credential-proxy.ts` (route resolution ~lines 452–486; cred branch ~line 542)
- Modify: `src/container-runner.ts:543` (`ANTHROPIC_BASE_URL`)
- Test: `src/credential-proxy.test.ts` (create if absent)

Run host tests with: `pnpm exec vitest run src/credential-proxy.test.ts`

- [ ] **Step 1: Write failing tests for `resolveProxyRoute`**

Create (or add to) `src/credential-proxy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveProxyRoute } from './credential-proxy.js';

describe('resolveProxyRoute', () => {
  it('routes the new /anthropic prefix and strips it', () => {
    expect(resolveProxyRoute('/anthropic/v1/messages')).toEqual({ route: 'anthropic', upstreamPath: '/v1/messages' });
  });
  it('routes openai / openai-platform / omlx / clemson with prefix stripped', () => {
    expect(resolveProxyRoute('/openai/v1/responses')).toEqual({ route: 'openai', upstreamPath: '/v1/responses' });
    expect(resolveProxyRoute('/openai-platform/v1/chat/completions')).toEqual({ route: 'openai-platform', upstreamPath: '/v1/chat/completions' });
    expect(resolveProxyRoute('/omlx/v1/chat/completions')).toEqual({ route: 'omlx', upstreamPath: '/v1/chat/completions' });
    expect(resolveProxyRoute('/clemson/v1/responses')).toEqual({ route: 'clemson', upstreamPath: '/v1/responses' });
  });
  it('routes googleapis (kept for the allowlist gate to reject)', () => {
    expect(resolveProxyRoute('/googleapis/drive/v3/files')).toEqual({ route: 'googleapis', upstreamPath: '/drive/v3/files' });
  });
  it('returns null for the bare path and unrecognized prefixes (no catch-all)', () => {
    expect(resolveProxyRoute('/v1/messages')).toBeNull();
    expect(resolveProxyRoute('/')).toBeNull();
    expect(resolveProxyRoute('/foo/bar')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `resolveProxyRoute` is not exported.

- [ ] **Step 3: Add the `ProxyRoute` type + `resolveProxyRoute` export**

In `src/credential-proxy.ts`, near the top (after imports), add:

```ts
export type ProxyRoute = 'anthropic' | 'openai' | 'openai-platform' | 'omlx' | 'clemson' | 'googleapis';

/**
 * Map a raw proxy request path to its provider route + the upstream path
 * (prefix stripped). Returns null for the bare path / any unrecognized prefix —
 * there is NO provider catch-all; null callers must fail closed (403).
 */
export function resolveProxyRoute(rawUrl: string): { route: ProxyRoute; upstreamPath: string } | null {
  const prefixes: Array<[ProxyRoute, string]> = [
    ['anthropic', '/anthropic'],
    ['openai-platform', '/openai-platform'],
    ['openai', '/openai'],
    ['omlx', '/omlx'],
    ['clemson', '/clemson'],
    ['googleapis', '/googleapis'],
  ];
  for (const [route, prefix] of prefixes) {
    if (rawUrl === prefix || rawUrl.startsWith(prefix + '/')) {
      return { route, upstreamPath: rawUrl.slice(prefix.length) || '/' };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the request handler to use `resolveProxyRoute` + fail-closed default**

In `src/credential-proxy.ts`, replace the route-detection + `upstreamUrl`/`upstreamPath` block (current lines ~452–486, from `const rawUrl = req.url || '/';` through the end of the `upstreamPath` ternary) with:

```ts
        const rawUrl = req.url || '/';
        const resolved = resolveProxyRoute(rawUrl);
        if (!resolved) {
          log.warn('credential-proxy: egress blocked (unrecognized route)', {
            rawUrl,
            src: req.socket.remoteAddress,
          });
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'endpoint not allowed by nanoclaw egress policy' }));
          return;
        }
        const { route, upstreamPath } = resolved;
        const isOpenAIPlatform = route === 'openai-platform';
        const isOpenAI = route === 'openai';
        const isOmlx = route === 'omlx';
        const isClemson = route === 'clemson';
        const isGoogle = route === 'googleapis';
        const isAnthropic = route === 'anthropic';

        const rawAgentGroup = req.headers[AGENT_GROUP_HEADER];
        const agentGroupId = typeof rawAgentGroup === 'string' && rawAgentGroup.length > 0 ? rawAgentGroup : null;

        const upstreamUrl = isGoogle
          ? googleUpstream
          : isOpenAI || isOpenAIPlatform
            ? openaiUpstream
            : isOmlx
              ? omlxUpstream
              : isClemson
                ? clemsonUpstream
                : anthropicUpstream; // route === 'anthropic'
```

(This preserves the existing `isOpenAI`/`isOmlx`/etc. booleans the downstream cred-injection blocks rely on, but now they're derived from the explicit route, and `upstreamPath` comes from `resolveProxyRoute`.)

Also update the now-stale routing comment directly above (current lines ~448–451, `//   /openai/* → OpenAI …` / `//   everything else → Anthropic (existing behaviour)`) to describe the new scheme: every provider is reached by an explicit prefix (`/anthropic`, `/openai`, `/openai-platform`, `/omlx`, `/clemson`, `/googleapis`); unrecognized/bare paths fail closed (403); `/googleapis` is gated off by an empty allowlist.

- [ ] **Step 6: Update the cred-resolution branch to key on `isAnthropic`**

In `src/credential-proxy.ts` (~line 542), change:

```ts
        if (agentGroupId && (isOpenAI || isOpenAIPlatform || (!isGoogle && !isOmlx && !isClemson))) {
```

to:

```ts
        if (agentGroupId && (isOpenAI || isOpenAIPlatform || isAnthropic)) {
```

- [ ] **Step 7: Point the Anthropic SDK at the `/anthropic` prefix**

In `src/container-runner.ts:543`, change:

```ts
  args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);
```

to:

```ts
  args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/anthropic`);
```

(No `pi.ts` change needed: `pi.ts:356` sets `model.baseUrl = process.env.ANTHROPIC_BASE_URL`, so the SDK posts to `…/anthropic/v1/messages`; the proxy strips `/anthropic` → `/v1/messages`. `proxy-fetch.ts` derives the proxy origin from the URL's `host`, which is unchanged by the path prefix.)

- [ ] **Step 8: Build + run host tests**

Run: `pnpm run build && pnpm exec vitest run src/credential-proxy.test.ts`
Expected: build clean, tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts src/container-runner.ts
git commit -m "feat(proxy): explicit /anthropic prefix, no provider catch-all (unrecognized -> 403)"
```

---

## Task 3: Per-route path allowlist + `/googleapis` fail-closed (host)

**Files:**
- Modify: `src/credential-proxy.ts` (add allowlist + gate after route resolution)
- Test: `src/credential-proxy.test.ts`

- [ ] **Step 1: Write failing tests for the allowlist predicate**

Add to `src/credential-proxy.test.ts`:

```ts
import { isEgressAllowed } from './credential-proxy.js';

describe('isEgressAllowed', () => {
  it('allows only the chat/messages endpoints per route', () => {
    expect(isEgressAllowed('anthropic', 'POST', '/v1/messages')).toBe(true);
    expect(isEgressAllowed('openai', 'POST', '/v1/responses')).toBe(true);
    expect(isEgressAllowed('openai', 'POST', '/v1/chat/completions')).toBe(true);
    expect(isEgressAllowed('openai-platform', 'POST', '/v1/chat/completions')).toBe(true);
    expect(isEgressAllowed('omlx', 'POST', '/v1/responses')).toBe(true);
    expect(isEgressAllowed('clemson', 'POST', '/v1/chat/completions')).toBe(true);
  });
  it('blocks the proven exploit and other non-chat endpoints', () => {
    expect(isEgressAllowed('openai', 'POST', '/v1/models')).toBe(false); // the proven SSRF finding
    expect(isEgressAllowed('openai', 'GET', '/v1/responses')).toBe(false); // wrong method
    expect(isEgressAllowed('anthropic', 'POST', '/v1/models')).toBe(false);
    expect(isEgressAllowed('anthropic', 'GET', '/v1/messages')).toBe(false);
  });
  it('blocks the entire googleapis route (empty allowlist, dead route)', () => {
    expect(isEgressAllowed('googleapis', 'GET', '/drive/v3/files')).toBe(false);
    expect(isEgressAllowed('googleapis', 'POST', '/gmail/v1/users/me/messages/send')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `isEgressAllowed` not exported.

- [ ] **Step 3: Add the allowlist constant + predicate**

In `src/credential-proxy.ts`, below `resolveProxyRoute`, add:

```ts
/**
 * Per-route upstream-path allowlist. Only these (METHOD, path) pairs are
 * forwarded; everything else → 403 with no credential injected. `googleapis`
 * is intentionally empty — the route is dead (the GWS relay calls Google
 * directly), so it must reject everything. Query strings are ignored (matched
 * on pathname only).
 */
export const EGRESS_ALLOWLIST: Record<ProxyRoute, string[]> = {
  // /api/oauth/... is the OAuth-mode token→temp-key exchange the proxy injects
  // on (see module docstring); REQUIRED or OAuth-mode installs break.
  anthropic: ['POST /v1/messages', 'POST /api/oauth/claude_cli/create_api_key'],
  openai: ['POST /v1/responses', 'POST /v1/chat/completions'],
  'openai-platform': ['POST /v1/responses', 'POST /v1/chat/completions'],
  omlx: ['POST /v1/chat/completions', 'POST /v1/responses'],
  clemson: ['POST /v1/chat/completions', 'POST /v1/responses'],
  googleapis: [],
};

export function isEgressAllowed(route: ProxyRoute, method: string, upstreamPath: string): boolean {
  const pathname = upstreamPath.split('?')[0];
  return EGRESS_ALLOWLIST[route].includes(`${method.toUpperCase()} ${pathname}`);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate the request handler on the allowlist (before any cred injection)**

In `src/credential-proxy.ts`, immediately after the `const upstreamUrl = …` block added in Task 2 Step 5 (and before the payload-log block ~line 490), insert:

```ts
        if (!isEgressAllowed(route, req.method || 'GET', upstreamPath)) {
          log.warn('credential-proxy: egress blocked (path not allowed)', {
            route,
            method: req.method,
            upstreamPath: upstreamPath.split('?')[0],
            src: req.socket.remoteAddress,
          });
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'endpoint not allowed by nanoclaw egress policy' }));
          return;
        }
```

- [ ] **Step 6: Mark the now-unreachable `isGoogle` injection block**

In `src/credential-proxy.ts`, add a one-line comment above the `if (isGoogle) {` block (~line 571):

```ts
        // NOTE: unreachable since 2026-06-10 — `/googleapis` has an empty egress
        // allowlist (Task 3) and 403s above. Kept for a future per-student
        // GWS-through-proxy design, which must add its own controls. See spec.
        if (isGoogle) {
```

- [ ] **Step 7: Build + run host tests**

Run: `pnpm run build && pnpm exec vitest run src/credential-proxy.test.ts`
Expected: build clean, tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat(proxy): per-route egress allowlist (chat endpoints only); googleapis fail-closed"
```

---

## Task 4: Full verification + live re-probe + state.md

**Files:**
- Modify: `state.md` (decision-log entry)

- [ ] **Step 1: Full host suite + agent-runner suite + typechecks**

```bash
pnpm run build
pnpm test
cd container/agent-runner && bun test && bun run typecheck && cd -
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```
Expected: build clean, all suites green, 0 type errors.

- [ ] **Step 2: Deploy to the live box**

`fetch_url` is an agent-runner source change (picked up via the runtime RO mount on the next container spawn — no image rebuild). The proxy + container-runner changes are host-side: restart the host.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
sleep 5
```

- [ ] **Step 3: Live re-probe — the exploit must now 403, legit traffic must still work**

```bash
cat > /tmp/egress-reprobe.sh <<'EOF'
probe() { code=$(curl -s -o /dev/null -m 6 -w '%{http_code}' "$1" 2>/dev/null) || code="conn-fail"; printf '  %-48s -> %s\n' "$1" "$code"; }
echo "[these must now be 403 — egress blocked]"
probe "http://192.168.64.1:3001/openai/v1/models"        # was 200 (the proven exploit)
probe "http://192.168.64.1:3001/v1/messages"             # bare anthropic path (no /anthropic prefix) -> 403
probe "http://192.168.64.1:3001/googleapis/drive/v3/files" # dead route -> 403
EOF
container run --rm -v /tmp/egress-reprobe.sh:/tmp/egress-reprobe.sh:ro --entrypoint bash nanoclaw-agent-v2-581fefa4:latest /tmp/egress-reprobe.sh 2>&1 | grep -vE '^\[[0-9]/[0-9]\]'
rm -f /tmp/egress-reprobe.sh
```
Expected: all three → `403`.

- [ ] **Step 4: Live functional check — a real agent turn still works**

Send a message that exercises a real LLM call + `web_search` + `fetch_url` through one of the demo agents (openai-codex), then confirm a reply lands:

```bash
curl -s -m 15 -X POST "http://127.0.0.1:3002/api/drafts/owner_01/messages?seat=owner_01" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Search the web for the EU AI Act, then fetch one of the result URLs and summarize it in two sentences."}' | head -c 200
```
Then verify a non-error assistant reply appears in the owner's session outbound DB (find the newest `data/v2-sessions/*/sess-*/outbound.db` and read the latest `messages_out` text). Expected: a real answer (LLM call via `/openai/v1/responses` succeeded, `web_search` via SearXNG worked, `fetch_url` of an external URL worked). Confirms the allowlist didn't break legit traffic.

- [ ] **Step 5: `fetch_url` internal-target negative check (live)**

Ask the same agent to `fetch_url http://192.168.64.1:3001/openai/v1/models` and confirm the tool result is `blocked by egress policy`, not page content. (Inspect the outbound trace for the `fetch_url` tool result.) Expected: blocked.

- [ ] **Step 6: Update `state.md` decision log**

Add a newest-first entry under `## Decision log` summarizing: egress control shipped — `fetch_url` internal-IP denylist + redirect re-validation; proxy explicit-prefix routing with new `/anthropic` prefix and no catch-all (unrecognized → 403); per-route allowlist (chat/messages/responses only); `/googleapis` failed closed (dead route). Note the proven `/openai/v1/models` exploit now 403s; the `/anthropic` routing is trunk-wide and the next Anthropic-using install (personal) must live-verify a Claude turn after deploy; network-layer egress (bash/curl) remains the out-of-scope follow-up.

- [ ] **Step 7: Commit**

```bash
git add state.md
git commit -m "docs(state): record agent egress control shipped + live-verified"
```

---

## Notes / invariants

- **Fail-closed everywhere.** Unrecognized proxy route → 403; non-allowlisted path → 403 (no creds attached); `fetch_url` DNS failure / blocked IP → refuse.
- **No image rebuild** for `fetch_url` (RO source mount); host restart for the proxy/container-runner changes.
- **`/anthropic` is trunk-wide.** This box has no Anthropic creds so it can't be live-verified here; the next Anthropic-using install must confirm a real Claude turn after deploy (flagged in the state.md entry).
- **Out of scope (do not implement here):** network-layer egress control (bash/curl/chromium reaching SearXNG/relay/LAN/internet, external exfil). SearXNG (`8888`) and the GWS relay (`3007`) stay reachable by design.
