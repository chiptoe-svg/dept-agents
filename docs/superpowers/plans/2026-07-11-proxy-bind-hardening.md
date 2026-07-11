# Credential-Proxy / GWS-Relay Bind Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop binding the two credential-bearing local HTTP services — the credential proxy (`:3001`) and the GWS MCP relay (`:3007`) — to `0.0.0.0`; bind each to loopback (`127.0.0.1`) plus the container bridge gateway (`192.168.65.1`) instead, so the Clemson campus network can no longer reach them.

**Architecture:** Add one small helper, `listenLoopbackAndGateway`, that binds a single HTTP request handler to two servers: a loopback server (bound immediately — always available, preserves the proxy's loopback-trust path for host direct-chat) and a gateway server (bound to the bridge gateway with background retry, because on Apple Container `bridge100` may not exist until the first container starts). The helper never binds a wildcard address; if handed one it coerces to loopback and warns. Both `startCredentialProxy` and `startGwsMcpRelay` route their existing handler through the helper and return a `DualBindHandle` whose `close()` tears down both servers.

**Tech Stack:** Node `http` (host runtime, Node + pnpm), vitest, TypeScript ESM (`.js` import specifiers).

## Global Constraints

- Host code only (`src/`). No container (`container/agent-runner/`) changes — do not touch the Bun tree. Host tests are **vitest** (`import { describe, it, expect } from 'vitest'`), never `bun:test`.
- **Never read, print, echo, or log any secret** (`.env` values, API keys, OAuth tokens). This plan touches the credential proxy; assert on bind addresses/booleans, never on credential contents. The only `.env` key this plan reads or writes is `CREDENTIAL_PROXY_HOST` (a bind address, not a secret).
- Do not weaken the existing security contracts: the proxy's per-container token identity (loopback callers are host-internal/trusted, `credential-proxy.ts:557`) and the GWS relay's token-derived identity (`resolveRelayIdentity`) must be unchanged. This plan changes only *which network addresses the listeners bind*, never who is authorized.
- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `import { CONTAINER_HOST_GATEWAY } from './container-runtime.js'`).
- `pnpm run build` (tsc) must be clean and `pnpm test` green before any task is marked complete. Run these yourself; do not trust a subagent's word for a clean build.
- Clean up any stray `groups/` fixture directories your test run creates; leave pre-existing ones (`_default_participant`, `owner_01`, `user_01`) alone.
- Commit messages end, after a blank line, with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `src/net-bind.ts`** — the `listenLoopbackAndGateway` helper + `DualBindHandle` type. One responsibility: bind an HTTP handler to loopback + gateway without ever exposing a wildcard, with gateway-bind retry. Reused by both services (justifies a shared module over inline duplication).
- **Create `src/net-bind.test.ts`** — unit tests for the helper using loopback-family addresses (`127.0.0.1` + `::1`) as stand-ins for loopback + gateway, so no real bridge is needed.
- **Modify `src/credential-proxy.ts`** — `startCredentialProxy` returns `Promise<DualBindHandle>` and binds via the helper; the request handler body is unchanged.
- **Modify `src/gws-mcp-relay.ts`** — `startGwsMcpRelay` returns `Promise<DualBindHandle>`, stores it in the module singleton, and `stopGwsMcpRelay` closes it via the helper; the request handler is unchanged.
- **Modify `src/index.ts`** — store the proxy handle (already typed `{ close: () => void }`, so compatible) and ensure both servers close on shutdown.
- **Modify `.env`** — `CREDENTIAL_PROXY_HOST=0.0.0.0` → `CREDENTIAL_PROXY_HOST=127.0.0.1`.
- **Create `docs/superpowers/reviews/2026-07-11-proxy-bind-verification.md`** — live evidence (Task 4).

---

### Task 1: `listenLoopbackAndGateway` helper

**Files:**
- Create: `src/net-bind.ts`
- Test: `src/net-bind.test.ts`

**Interfaces:**
- Consumes: `CONTAINER_HOST_GATEWAY(): string` from `./container-runtime.js` (default gateway resolver); `log` from `./log.js`.
- Produces:
  - `interface DualBindHandle { servers: import('http').Server[]; close(): void; }`
  - `function listenLoopbackAndGateway(handler: (req: IncomingMessage, res: ServerResponse) => void, port: number, opts?: { loopbackHost?: string; resolveGateway?: () => string; retryMs?: number; label?: string }): Promise<DualBindHandle>`
  - Resolves as soon as the **loopback** server is listening (loopback is the must-have). The gateway server binds asynchronously with retry and is pushed into `handle.servers` once bound. `close()` closes every bound server and cancels any pending gateway-retry timer.

**Behavior contract (the reviewer's rubric):**
1. Binds loopback immediately at `opts.loopbackHost ?? '127.0.0.1'`. If that host is a wildcard (`'0.0.0.0'`, `'::'`, or empty string), coerce to `'127.0.0.1'` and `log.warn` that a wildcard bind was refused. **Never** bind `0.0.0.0`.
2. Resolves the gateway via `opts.resolveGateway ?? CONTAINER_HOST_GATEWAY`. If the resolved gateway equals the loopback host, skip the second bind (nothing to add) and do not error.
3. Attempts to bind the gateway server. On failure (address not yet assignable — `EADDRNOTAVAIL` — or the resolver throwing because the runtime isn't ready), retry after `opts.retryMs ?? 2000` ms, indefinitely, until it binds. Log attempts at `debug`, success at `info`. This is safe because no container can reach `gateway:port` until `bridge100` exists, which is the same condition that makes the bind succeed.
4. `close()` is idempotent and closes both servers plus clears the retry timer.
5. The **resolved gateway** is also guarded against wildcards: if `resolveGateway()` returns `'0.0.0.0'`, `'::'`, or `''`, do NOT bind it — `log.warn` and schedule a retry (it may resolve to a real address later). The helper never binds a wildcard on either the loopback or the gateway path.
6. `close()` racing an in-flight gateway `listen()` must not leak a bound server: the gateway listening callback re-checks `closed` and closes itself instead of pushing when the handle was already closed.

- [ ] **Step 1: Write the failing tests**

Create `src/net-bind.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, get as httpGet, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { listenLoopbackAndGateway, DualBindHandle } from './net-bind.js';

// Mock the default gateway resolver so tests never touch a real bridge.
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: () => '::1',
}));

const handles: DualBindHandle[] = [];
afterEach(() => {
  for (const h of handles) h.close();
  handles.length = 0;
});

const okHandler = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200);
  res.end('ok');
};

/** Resolve the port a given server bound to. */
function portOf(h: DualBindHandle, host: string): number {
  const s = h.servers.find((srv) => (srv.address() as AddressInfo)?.address === host);
  if (!s) throw new Error(`no server bound to ${host}`);
  return (s.address() as AddressInfo).port;
}

/** True if an HTTP GET to host:port returns 200 within the timeout. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host, port, timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

describe('listenLoopbackAndGateway', () => {
  it('binds loopback and the gateway, but not a third address', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      resolveGateway: () => '::1',
      retryMs: 20,
    });
    handles.push(h);
    // Both binds share the SAME port (port 0 picks one; gateway reuses it).
    // Wait briefly for the async gateway bind.
    await new Promise((r) => setTimeout(r, 100));
    const port = portOf(h, '127.0.0.1');
    expect(await reachable('127.0.0.1', port)).toBe(true);
    expect(await reachable('::1', port)).toBe(true);
    // A loopback address we did NOT bind must be unreachable.
    expect(await reachable('127.0.0.3', port)).toBe(false);
  });

  it('coerces a wildcard loopbackHost to 127.0.0.1 and never binds 0.0.0.0', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      loopbackHost: '0.0.0.0',
      resolveGateway: () => '::1',
      retryMs: 20,
    });
    handles.push(h);
    // No server may be bound to the wildcard address.
    const boundAddrs = h.servers.map((s) => (s.address() as AddressInfo).address);
    expect(boundAddrs).not.toContain('0.0.0.0');
    expect(boundAddrs).toContain('127.0.0.1');
  });

  it('retries the gateway bind until the address becomes available', async () => {
    let attempts = 0;
    // First two resolves throw (simulating bridge-not-up), third returns a real addr.
    const resolveGateway = () => {
      attempts += 1;
      if (attempts < 3) throw new Error('bridge not up yet');
      return '::1';
    };
    const h = await listenLoopbackAndGateway(okHandler, 0, { resolveGateway, retryMs: 20 });
    handles.push(h);
    // Loopback is up immediately even though the gateway is not.
    const port = portOf(h, '127.0.0.1');
    expect(await reachable('127.0.0.1', port)).toBe(true);
    // After enough retry cycles the gateway binds too.
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(await reachable('::1', port)).toBe(true);
  });

  it('skips the second bind when the gateway equals loopback', async () => {
    const h = await listenLoopbackAndGateway(okHandler, 0, {
      loopbackHost: '127.0.0.1',
      resolveGateway: () => '127.0.0.1',
      retryMs: 20,
    });
    handles.push(h);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.servers).toHaveLength(1);
  });
});
```

> **Note on the shared port:** binding two `http.Server` instances to *different* addresses on the *same* explicit port is fine. With `port: 0` the loopback server picks an ephemeral port; the gateway server must then bind that same chosen port on its own address. The implementation must read the loopback server's chosen port (`(server.address() as AddressInfo).port`) and pass it to the gateway `listen()` call, rather than passing `0` again (which would pick a different port). Tests above assume both share the loopback-chosen port.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/net-bind.test.ts`
Expected: FAIL — `Cannot find module './net-bind.js'` / `listenLoopbackAndGateway is not a function`.

- [ ] **Step 3: Implement the helper**

Create `src/net-bind.ts`:

```ts
/**
 * Bind an HTTP handler to loopback + the container bridge gateway — never a
 * wildcard. Credential-bearing local services (credential proxy, GWS relay)
 * must be reachable by host direct-chat (loopback) and by containers (the
 * bridge gateway) but NOT by the campus LAN. Binding 0.0.0.0 would expose
 * real API keys / OAuth tokens to anything that can route to the host IP.
 *
 * The loopback server binds immediately (always available; preserves the
 * proxy's loopback-trust path). The gateway server binds with retry because
 * on Apple Container the bridge interface (bridge100 / 192.168.65.1) may not
 * exist until the first container starts — and the proxy starts first. No
 * container can reach gateway:port before the bridge exists, so retrying the
 * bind until it succeeds has no correctness gap.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { log } from './log.js';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

export interface DualBindHandle {
  /** Bound servers: loopback always; gateway appended once the bridge is up. */
  servers: Server[];
  /** Idempotently close every bound server and cancel any pending retry. */
  close(): void;
}

export interface DualBindOptions {
  loopbackHost?: string;
  resolveGateway?: () => string;
  retryMs?: number;
  label?: string;
}

export function listenLoopbackAndGateway(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port: number,
  opts: DualBindOptions = {},
): Promise<DualBindHandle> {
  const label = opts.label ?? 'service';
  const retryMs = opts.retryMs ?? 2000;
  const resolveGateway = opts.resolveGateway ?? CONTAINER_HOST_GATEWAY;

  let loopbackHost = opts.loopbackHost ?? '127.0.0.1';
  if (WILDCARD_HOSTS.has(loopbackHost)) {
    log.warn(`Refusing to bind ${label} to a wildcard address; using 127.0.0.1`, {
      requested: loopbackHost,
    });
    loopbackHost = '127.0.0.1';
  }

  const servers: Server[] = [];
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const handle: DualBindHandle = {
    servers,
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      for (const s of servers) {
        try {
          s.close();
        } catch {
          // best-effort
        }
      }
    },
  };

  return new Promise((resolve, reject) => {
    const loopback = createServer(handler);
    loopback.on('error', reject);
    loopback.listen(port, loopbackHost, () => {
      servers.push(loopback);
      const boundPort = (loopback.address() as AddressInfo).port;
      log.info(`${label} listening`, { host: loopbackHost, port: boundPort });

      // Now bring up the gateway server on the SAME port, with retry.
      const bindGateway = () => {
        if (closed) return;
        let gateway: string;
        try {
          gateway = resolveGateway();
        } catch (err) {
          log.debug(`${label}: gateway not resolvable yet, will retry`, { err: String(err) });
          retryTimer = setTimeout(bindGateway, retryMs);
          return;
        }
        if (gateway === loopbackHost) {
          log.debug(`${label}: gateway equals loopback, no second bind needed`, { gateway });
          return;
        }
        const gwServer = createServer(handler);
        gwServer.once('error', (err: NodeJS.ErrnoException) => {
          log.debug(`${label}: gateway bind failed, will retry`, { gateway, code: err.code });
          try {
            gwServer.close();
          } catch {
            // best-effort
          }
          if (!closed) retryTimer = setTimeout(bindGateway, retryMs);
        });
        gwServer.listen(boundPort, gateway, () => {
          servers.push(gwServer);
          log.info(`${label} listening`, { host: gateway, port: boundPort });
        });
      };
      bindGateway();

      resolve(handle);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/net-bind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + build**

Run: `pnpm run build`
Expected: clean (no tsc errors).

- [ ] **Step 6: Commit**

```bash
git add src/net-bind.ts src/net-bind.test.ts
git commit -m "feat(net): loopback+gateway dual-bind helper (no wildcard exposure)"
```

---

### Task 2: Route the credential proxy and GWS relay through the helper

**Files:**
- Modify: `src/credential-proxy.ts` (`startCredentialProxy`, ~line 481 and ~line 909)
- Modify: `src/gws-mcp-relay.ts` (`startGwsMcpRelay` ~line 126, `stopGwsMcpRelay` ~line 149, module singleton ~line 124)
- Modify: `src/index.ts` (proxy start ~line 165, shutdown ~line 308)
- Modify: `.env` (`CREDENTIAL_PROXY_HOST`)
- Test: `src/credential-proxy.test.ts` (adjust for the new return type)

**Interfaces:**
- Consumes: `listenLoopbackAndGateway`, `DualBindHandle` from `./net-bind.js` (Task 1).
- Produces: `startCredentialProxy(port, host?, payloadLogBaseDir?): Promise<DualBindHandle>`; `startGwsMcpRelay(host?): Promise<DualBindHandle>`.

> **Context the implementer needs:** In `index.ts`, `proxyServer` is already typed `let proxyServer: { close: () => void } | null` and shutdown calls `proxyServer?.close()` — a `DualBindHandle` satisfies that structural type, so `index.ts`'s proxy wiring needs no change beyond the call itself still compiling. `startGwsMcpRelay`'s return is currently ignored at the call site (`await startGwsMcpRelay(PROXY_BIND_HOST)`), and shutdown goes through `stopGwsMcpRelay()`. The proxy's request handler (the big `createServer((req, res) => { ... })` body, lines ~519–907) and the relay's `handleRequest` are **unchanged** — only the listen/bind mechanism changes.

- [ ] **Step 1: Adjust the credential-proxy tests for the new return type**

`src/credential-proxy.test.ts` currently starts the proxy and likely stores the returned `Server`, calling `.close()` in teardown and reading `.address()` for the port. Update the harness so it reads the loopback server's port from the handle. Find where the test starts the proxy (search for `startCredentialProxy(`) and where it derives the base URL/port. Replace any `server.address()` / `server.close()` usage with the handle:

```ts
// BEFORE (illustrative):
//   proxy = await startCredentialProxy(0, '127.0.0.1');
//   const { port } = proxy.address() as AddressInfo;
// AFTER:
const proxy = await startCredentialProxy(0, '127.0.0.1');
const loopback = proxy.servers.find(
  (s) => (s.address() as AddressInfo).address === '127.0.0.1',
)!;
const { port } = loopback.address() as AddressInfo;
// teardown: proxy.close();
```

If the tests bind the proxy on `127.0.0.1` (they do — see `upstreamServer.listen(0, '127.0.0.1', ...)` throughout), the gateway thunk must not interfere. Pass a resolveGateway that equals loopback so no second bind happens in unit tests — but `startCredentialProxy` does not currently take that option. Instead, in these tests set the env override so `CONTAINER_HOST_GATEWAY()` returns `127.0.0.1`, making the gateway bind a no-op (Task-1 helper skips it):

```ts
// In the proxy test setup, before starting the proxy:
process.env.CONTAINER_HOST_GATEWAY = '127.0.0.1';
```

Place that in the existing `beforeEach`/`beforeAll` (or at the top of each test that starts the proxy). Add `import { AddressInfo } from 'net';` if not present.

- [ ] **Step 2: Run the proxy tests to verify they fail against the current code**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: FAIL — `proxy.servers is undefined` (current `startCredentialProxy` returns a bare `Server`).

- [ ] **Step 3: Rewire `startCredentialProxy` to return a `DualBindHandle`**

In `src/credential-proxy.ts`:

1. Add to imports near the top:
   ```ts
   import { listenLoopbackAndGateway, DualBindHandle } from './net-bind.js';
   ```
2. Change the signature and return type:
   ```ts
   export function startCredentialProxy(
     port: number,
     host = '127.0.0.1',
     payloadLogBaseDir?: string,
   ): Promise<DualBindHandle> {
   ```
3. Replace the `return new Promise((resolve, reject) => { const server = createServer((req, res) => { ... }); ... server.listen(port, host, ...); server.on('close', ...); server.on('error', reject); });` structure so the handler is bound via the helper. Concretely: extract the request-handler arrow (everything passed to `createServer`) into a named `const requestHandler = (req: IncomingMessage, res: ServerResponse) => { ... }` (the body is unchanged), then:
   ```ts
   const handle = await listenLoopbackAndGateway(requestHandler, port, {
     loopbackHost: host,
     label: 'Credential proxy',
   });
   // The payload-log store cleanup that was in server.on('close', …) must run
   // when the loopback server closes. Attach it to every bound server:
   if (payloadLogCtx) {
     const closeStores = () => {
       for (const store of payloadLogCtx.stores.values()) {
         if (store) {
           try {
             store.close();
           } catch {
             // best-effort close
           }
         }
       }
     };
     for (const s of handle.servers) s.on('close', closeStores);
   }
   return handle;
   ```
   This requires making the function `async` (it currently returns `new Promise`). Convert `export function startCredentialProxy(...)` to `export async function startCredentialProxy(...)`. The `authMode` log line that was inside the old `listen` callback (`log.info('Credential proxy started', { port, host, authMode })`) is superseded by the helper's own per-bind `log.info('Credential proxy listening', ...)`; you may drop it or keep one summary line after `listenLoopbackAndGateway` resolves — keep it minimal.

   > Note: `payloadLogCtx.stores` is populated lazily as requests arrive; new gateway servers appended to `handle.servers` after `close` handlers are attached is a non-issue because the store cleanup reads the shared `payloadLogCtx.stores` map at close time regardless of which server fired. If a gateway server binds *after* this loop runs, attach the same `closeStores` in the helper is not possible; instead, guard by also closing stores in the `index.ts` shutdown is unnecessary — the loopback server's close event already flushes all stores. Attaching to loopback alone is sufficient; attaching to all currently-known servers is a bonus. Do NOT over-engineer: attaching `closeStores` to the loopback server only is acceptable and simplest.

4. Remove the now-unused `Server` import if nothing else in the file uses it (check: `import { createServer, Server } from 'http'` at line 47 — `createServer` is still used by the extracted handler? No: the helper now calls `createServer`. If `credential-proxy.ts` no longer calls `createServer` directly, drop it from the import too, but keep `IncomingMessage`/`ServerResponse` types if referenced. Verify with tsc.)

- [ ] **Step 4: Run the proxy tests to verify they pass**

Run: `pnpm exec vitest run src/credential-proxy.test.ts`
Expected: PASS (all existing proxy tests green with the handle-based harness).

- [ ] **Step 5: Rewire `startGwsMcpRelay` / `stopGwsMcpRelay`**

In `src/gws-mcp-relay.ts`:

1. Add import:
   ```ts
   import { listenLoopbackAndGateway, DualBindHandle } from './net-bind.js';
   ```
2. Replace the module singleton and start/stop:
   ```ts
   let handle: DualBindHandle | null = null;

   export async function startGwsMcpRelay(host = '127.0.0.1'): Promise<DualBindHandle> {
     if (handle) return handle;
     const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
       void handleRequest(req, res).catch((err) => {
         log.error('GWS MCP relay request error', { err: String(err) });
         if (!res.headersSent) {
           send(res, 500, { ok: false, error: String(err) });
         }
       });
     };
     handle = await listenLoopbackAndGateway(requestHandler, GWS_MCP_RELAY_PORT, {
       loopbackHost: host,
       label: 'GWS MCP relay',
     });
     return handle;
   }

   export async function stopGwsMcpRelay(): Promise<void> {
     if (!handle) return;
     handle.close();
     handle = null;
     log.info('GWS MCP relay stopped');
   }
   ```
3. Drop the now-unused `Server` import from `http` if nothing else references it (keep `IncomingMessage`, `ServerResponse`, `createServer` is no longer used directly here — remove it too if unused; verify with tsc).

- [ ] **Step 6: Update `.env`**

Change the single line:
```
CREDENTIAL_PROXY_HOST=0.0.0.0
```
to:
```
CREDENTIAL_PROXY_HOST=127.0.0.1
```
(Use an in-place edit; do not print other `.env` lines.)

- [ ] **Step 7: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full vitest suite green.

- [ ] **Step 8: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts src/gws-mcp-relay.ts src/index.ts .env
git commit -m "fix(security): bind credential proxy + GWS relay to loopback+gateway, not 0.0.0.0"
```

> If `.env` is git-ignored (it should be), it will not be staged — that is expected; the live-config change still takes effect for the running host. Note in the commit body that `.env`'s `CREDENTIAL_PROXY_HOST` was set to `127.0.0.1` out-of-tree.

---

### Task 3: Deploy and live-verify

**Files:**
- Create: `docs/superpowers/reviews/2026-07-11-proxy-bind-verification.md`

**This task has no unit tests — it verifies the running host.** The service label for this install is `com.nanoclaw-v2-581fefa4` (not the generic `com.nanoclaw`).

- [ ] **Step 1: Rebuild + restart the host**

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4
```
Wait ~5s for startup.

- [ ] **Step 2: Confirm the bind addresses changed**

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN; echo '---'; lsof -nP -iTCP:3007 -sTCP:LISTEN
```
Expected: for **both** ports, listeners on `127.0.0.1:PORT` and `192.168.65.1:PORT`, and **no** `*:PORT` (wildcard) row. Record the exact output.

- [ ] **Step 3: Confirm campus cannot reach the proxy but the gateway can**

```bash
# Loopback: reachable (some HTTP response, e.g. 404/400 — connection is what matters).
curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:3001/ || echo "no-loopback"
# Campus IP: connection must be REFUSED now (was accepted when bound to 0.0.0.0).
curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://130.127.162.67:3001/ && echo "REACHABLE-BAD" || echo "refused-good"
```
Expected: loopback returns an HTTP status code (proxy is up); the campus-IP curl fails to connect (`refused-good`). Record both.

- [ ] **Step 4: Confirm a real container turn still works (gateway path)**

Drive one message to the owner's agent group and confirm a reply is produced (the container reaches the proxy via `192.168.65.1:3001`). Use the same mechanism prior plans used for a live turn (post via the playground HTTP path with the operator session, or write to the session inbound DB and read the outbound reply). Confirm a non-empty reply and that the turn did not error on credential resolution.

- [ ] **Step 5: Confirm host direct-chat still works (loopback path)**

If direct-chat is exercised on this box, send one direct-chat request and confirm it completes (it reaches the proxy via `127.0.0.1:3001` and is treated as a loopback/host-internal caller). If direct-chat is not wired here, note that and rely on Step 4 + the loopback reachability in Step 3.

- [ ] **Step 6: Write the verification doc**

Create `docs/superpowers/reviews/2026-07-11-proxy-bind-verification.md` capturing: the `lsof` before/after (wildcard gone, loopback+gateway present on 3001 and 3007), the campus-refused vs loopback-reachable curls, and the successful container turn. Never paste any secret or token.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/reviews/2026-07-11-proxy-bind-verification.md
git commit -m "docs(review): live verification — proxy/relay bind hardening"
```

---

## Self-Review

**1. Spec coverage:**
- Close campus exposure of `:3001` and `:3007` → Tasks 1+2 (dual-bind, no wildcard) + Task 3 (live proof `*:` is gone).
- Preserve container path (gateway) and direct-chat path (loopback trust) → helper binds both; Task 3 Steps 4–5 verify.
- Cold-start robustness (bridge not up yet) → Task 1 gateway-retry + test 3.
- Prevent silent re-exposure via `.env` → Task 1 wildcard coercion + test 2.
- GWS relay folded in (same var, same exposure) → Task 2 Step 5.
- Webhook `:3003` deliberately out of scope → stated in this plan's Goal/Architecture; not touched.

**2. Placeholder scan:** No TBD/TODO; all code blocks are complete; tests contain real assertions.

**3. Type consistency:** `DualBindHandle` (`{ servers: Server[]; close(): void }`) is defined in Task 1 and consumed unchanged in Task 2; `listenLoopbackAndGateway` signature matches between definition and both call sites; `index.ts`'s `{ close: () => void }` structural type is satisfied by `DualBindHandle`.
