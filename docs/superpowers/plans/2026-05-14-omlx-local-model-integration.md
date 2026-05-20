# omlx Local Model Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mlx-omni-server as a third "local" provider peer to claude/codex, with per-agent routing, an mlx-omni discovery adapter, and a three-section Models tab in the playground.

**Architecture:** Promote `local` to a peer of `claude` and `codex` in the existing per-agent provider axis. The container's codex-app-server is reused for `local`; its `~/.codex/config.toml` gets a `[model_providers.omlx]` block pointed at the credential proxy's `/omlx/*` path, which forwards to `http://localhost:8000`. Model discovery follows the same `ModelProviderAdapter` registry pattern as claude/codex.

**Tech Stack:** TypeScript (host), Bun/TypeScript (container agent-runner), vitest (host tests), bun:test (container tests), plain-DOM playground UI.

**Spec reference:** `docs/superpowers/specs/2026-05-14-omlx-local-model-integration-design.md`

**Pre-existing groundwork (already in trunk, do not redo):**
- `src/credential-proxy.ts` already implements the `/omlx/*` route, reads `OMLX_API_KEY` / `OMLX_BASE_URL`, and forwards with `Authorization: Bearer <key|"local">`. Confirmed by grep on this branch. Task 5 verifies behavior end-to-end but does not re-implement.
- `src/container-config.ts` has the typed `allowedModels: { provider, model }[]` shape already.
- `src/model-discovery.ts` exports `listAllForProvider(provider)` and uses `getModelProvider(name)` so registering an adapter under `name: 'local'` is sufficient — no discovery refactor needed.

---

## Task 1: Add the omlx (`local`) model-provider adapter

**Goal:** A new `ModelProviderAdapter` with `name: 'local'`, hitting `localhost:8000/v1/models` with `Authorization: Bearer <OMLX_API_KEY|"local">`. Mirrors the openai.ts/anthropic.ts shape.

**Files:**
- Create: `src/model-providers/omlx.ts`
- Create: `src/model-providers/omlx.test.ts`
- Modify: `src/model-providers/index.ts` (one import + one array entry)

- [ ] **Step 1: Write the failing test**

Create `src/model-providers/omlx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { omlxAdapter, STATIC_OMLX } from './omlx.js';

describe('omlx adapter parseId', () => {
  it('passes through arbitrary mlx model ids verbatim', () => {
    const p = omlxAdapter.parseId('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.id).toBe('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.alias).toBe('Qwen3.6-35B-A3B-UD-MLX-4bit');
    expect(p?.bucket).toBeUndefined();
    expect(p?.rank).toEqual([]);
  });

  it('handles other model name shapes', () => {
    expect(omlxAdapter.parseId('mlx-community/Llama-3.2-3B-Instruct-4bit')?.id).toBe(
      'mlx-community/Llama-3.2-3B-Instruct-4bit',
    );
    expect(omlxAdapter.parseId('phi-3-mini-4k-instruct')?.id).toBe('phi-3-mini-4k-instruct');
  });

  it('never returns null — unlike cloud adapters, we accept anything mlx-omni emits', () => {
    expect(omlxAdapter.parseId('')).not.toBeNull();
    expect(omlxAdapter.parseId('weird id with spaces')).not.toBeNull();
  });
});

describe('omlx adapter pickTop', () => {
  it('sorts alphabetically and slices to maxCount', () => {
    const ids = ['zeta', 'alpha', 'mu', 'beta'];
    const parsed = ids
      .map((id) => omlxAdapter.parseId(id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const top = omlxAdapter.pickTop(parsed, 3);
    expect(top.map((m) => m.alias)).toEqual(['alpha', 'beta', 'mu']);
  });

  it('does not throw on empty input', () => {
    expect(omlxAdapter.pickTop([], 4)).toEqual([]);
  });
});

describe('omlx adapter metadata', () => {
  it('declares the correct registry identity', () => {
    expect(omlxAdapter.name).toBe('local');
    expect(omlxAdapter.defaultHost).toBe('localhost');
    expect(omlxAdapter.envBaseUrlVar).toBe('OMLX_BASE_URL');
    expect(omlxAdapter.modelsPath).toBe('/v1/models');
  });

  it('staticFallback contains the curated Qwen entry', () => {
    expect(STATIC_OMLX.some((h) => h.id.startsWith('Qwen3.6'))).toBe(true);
  });

  it('noteFor returns undefined (no curated aliases)', () => {
    expect(omlxAdapter.noteFor('anything')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/model-providers/omlx.test.ts`
Expected: FAIL with "Cannot find module './omlx.js'" or similar resolution error.

- [ ] **Step 3: Implement the adapter**

Create `src/model-providers/omlx.ts`:

```ts
/**
 * Local OpenAI-compatible model adapter — mlx-omni-server, Ollama, LM Studio,
 * and similar local servers that speak `/v1/models` with optional Bearer auth.
 *
 * Provider name is `local` (singular slot today — one local server per host).
 * Future work could split into `local-<name>` slots, but the pedagogy case
 * for now is "Mac running mlx-omni on :8000", so one slot suffices.
 *
 * Unlike anthropic.ts / openai.ts, this adapter does NOT impose an id shape.
 * mlx model names are arbitrary strings (`Qwen3.6-...`, `mlx-community/Llama-3.2-3B`,
 * a bare folder name, etc.), so `parseId` is lossless and `pickTop` sorts
 * alphabetically. There are no curated aliases — every id displays as itself.
 *
 * Auth: bearer `OMLX_API_KEY` if set; literal `local` otherwise. Many local
 * servers ignore auth entirely; we still send a bearer so downstreams that
 * require *any* token (mlx-omni-server's default config when a key is set)
 * succeed without per-deploy plumbing.
 */
import { readEnvFile } from '../env.js';
import type { AuthHeader, ModelHint, ModelProviderAdapter, ParsedModel } from './types.js';

const STATIC_FALLBACK: ModelHint[] = [
  { id: 'Qwen3.6-35B-A3B-UD-MLX-4bit', alias: 'Qwen3.6-35B-A3B-UD-MLX-4bit', note: 'MLX 4-bit, ~35B' },
];

function getAuth(): AuthHeader | null {
  const env = readEnvFile(['OMLX_API_KEY']);
  const key = env.OMLX_API_KEY ?? 'local';
  return { name: 'authorization', value: `Bearer ${key}` };
}

function parseId(id: string): ParsedModel {
  return { id, alias: id, rank: [] };
}

function pickTop(parsed: ParsedModel[], maxCount: number): ParsedModel[] {
  return [...parsed].sort((a, b) => a.id.localeCompare(b.id)).slice(0, maxCount);
}

const adapter: ModelProviderAdapter = {
  name: 'local',
  defaultHost: 'localhost',
  envBaseUrlVar: 'OMLX_BASE_URL',
  modelsPath: '/v1/models',
  getAuth,
  parseId,
  pickTop,
  noteFor: () => undefined,
  staticFallback: STATIC_FALLBACK,
};

export { adapter as omlxAdapter, STATIC_FALLBACK as STATIC_OMLX };
```

- [ ] **Step 4: Register the adapter**

Edit `src/model-providers/index.ts`:

```ts
// Existing imports:
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
// Add:
import { omlxAdapter } from './omlx.js';
import type { ModelProviderAdapter } from './types.js';

// Change:
const BUILTIN_ADAPTERS: ModelProviderAdapter[] = [anthropicAdapter, openaiAdapter, omlxAdapter];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/model-providers/omlx.test.ts`
Expected: PASS (all describe blocks green).

Also run: `pnpm test src/model-providers/` to confirm anthropic + openai tests still pass.

- [ ] **Step 6: Verify the resolveEndpoint path works for plain-http localhost**

`src/model-discovery.ts:115-134` reads `OMLX_BASE_URL` and parses it. For `http://localhost:8000` it should give `{ hostname: 'localhost', port: 8000, protocol: 'http:' }`. Confirm by reading those lines — no code change, but the protocol-aware http vs https dispatch on line 63 is what makes the local fetch work.

- [ ] **Step 7: Commit**

```bash
git add src/model-providers/omlx.ts src/model-providers/omlx.test.ts src/model-providers/index.ts
git commit -m "$(cat <<'EOF'
feat(model-providers): add omlx adapter for local mlx-omni discovery

Registers as provider 'local'. Hits localhost:8000/v1/models with bearer
OMLX_API_KEY (defaults to literal 'local'). No id-shape constraint —
mlx model names are arbitrary strings.
EOF
)"
```

---

## Task 2: Add `local` to the provider hint list

**Goal:** `/provider` Telegram command lists `local` as an option alongside `claude` and `codex`.

**Files:**
- Modify: `src/provider-switch.ts:48-51`

- [ ] **Step 1: Update the hint list**

Edit `src/provider-switch.ts:48-51`:

```ts
const PROVIDER_HINTS: ProviderHint[] = [
  { name: 'claude', note: 'Claude Agent SDK — Anthropic Opus/Sonnet/Haiku' },
  { name: 'codex', note: 'OpenAI Codex app-server — ChatGPT subscription or OPENAI_API_KEY' },
  { name: 'local', note: 'Local OpenAI-compatible server (mlx-omni-server on localhost:8000)' },
];
```

- [ ] **Step 2: Confirm `setProvider` already accepts arbitrary names**

Read `src/provider-switch.ts:82-136`. The function does not gate on a hardcoded allowlist — any string flows through to `container.json`, `sessions.agent_provider`, and `agent_groups.agent_provider`. No code change needed beyond the hint list update.

- [ ] **Step 3: Run host tests**

Run: `pnpm test`
Expected: PASS. No tests reference the hint list count; if any do, update them.

- [ ] **Step 4: Commit**

```bash
git add src/provider-switch.ts
git commit -m "$(cat <<'EOF'
feat(provider-switch): list 'local' as a provider hint

/provider on Telegram now shows local alongside claude and codex.
setProvider already accepts arbitrary names — only the hint UI changes.
EOF
)"
```

---

## Task 3: Add Qwen3.6 catalog entry and rename CLOUD_ENTRIES

**Goal:** The model catalog gets a curated `local` entry. Rename `CLOUD_ENTRIES` → `BUILTIN_ENTRIES` since it now carries non-cloud models.

**Files:**
- Modify: `src/model-catalog.ts`
- Modify: `src/model-catalog.test.ts` (if it references `CLOUD_ENTRIES`)

- [ ] **Step 1: Inspect the existing test file**

Run: `grep -n 'CLOUD_ENTRIES' src/model-catalog.test.ts`

If the constant name appears in the test, plan to update it in Step 3. Otherwise the rename is internal-only.

- [ ] **Step 2: Rename + add the Qwen entry**

Edit `src/model-catalog.ts`. Rename `CLOUD_ENTRIES` to `BUILTIN_ENTRIES` and append the Qwen entry:

```ts
const BUILTIN_ENTRIES: ModelEntry[] = [
  {
    id: 'claude-haiku-4-5',
    provider: 'claude',
    displayName: 'claude-haiku-4-5',
    origin: 'cloud',
    costPer1kTokensUsd: 0.0008,
    avgLatencySec: 0.9,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ Anthropic'],
    bestFor: 'Short answers, classification, structured output.',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'claude',
    displayName: 'claude-sonnet-4-6',
    origin: 'cloud',
    costPer1kTokensUsd: 0.012,
    avgLatencySec: 2.1,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['🐢 slower', '$$ pricier', '☁ Anthropic'],
    bestFor: 'Reasoning, long outputs.',
  },
  {
    id: 'gpt-5-mini',
    provider: 'codex',
    displayName: 'gpt-5-mini',
    origin: 'cloud',
    costPer1kTokensUsd: 0.0006,
    avgLatencySec: 1.0,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ OpenAI'],
    bestFor: 'Quick, broad-knowledge tasks.',
  },
  {
    id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
    provider: 'local',
    displayName: 'Qwen 3.6 (35B, MLX 4-bit)',
    origin: 'local',
    costPer1kTokensUsd: 0,
    avgLatencySec: 8,
    paramCount: '35B',
    modalities: ['text'],
    notes: 'Runs on the host Mac. Free, no quota — but slower than cloud.',
    host: 'http://localhost:8000',
    contextSize: 32768,
    quantization: 'MLX 4-bit',
    chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
    bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
  },
];

// Existing getModelCatalog body, but reference BUILTIN_ENTRIES:
export function getModelCatalog(): ModelEntry[] {
  return [...BUILTIN_ENTRIES, ...readLocalEntries()];
}
```

- [ ] **Step 3: Update the test if it references CLOUD_ENTRIES**

If Step 1 showed any matches, swap `CLOUD_ENTRIES` → `BUILTIN_ENTRIES` in `src/model-catalog.test.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/model-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model-catalog.ts src/model-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat(model-catalog): add Qwen3.6 local entry, rename to BUILTIN_ENTRIES

Curated baseline for the Local section of the playground Models tab.
Instructors can still override or extend via model-catalog-local.json.
EOF
)"
```

---

## Task 4: Refactor codex config.toml writer to emit model_providers

**Goal:** When the container is provider=`codex`, the runner writes a `[model_providers.openai]` block + top-level `model = ... / model_provider = "openai"`. When provider=`local`, it writes `[model_providers.omlx]` + top-level `model_provider = "omlx"`. Both flow through the same single `~/.codex/config.toml` write so the MCP servers and model providers stay consistent.

**Files:**
- Modify: `container/agent-runner/src/providers/codex-app-server.ts` (rename + extend)
- Modify: `container/agent-runner/src/providers/codex.ts` (call site at line 197)
- Create: `container/agent-runner/src/providers/codex-app-server.test.ts` (extend if exists)

- [ ] **Step 1: Check whether a test file exists for codex-app-server**

Run: `ls container/agent-runner/src/providers/codex-app-server*.test.ts 2>/dev/null || echo "no test file"`

If no file exists, Step 2 creates one. If one exists, Step 2 appends a new describe block.

- [ ] **Step 2: Write the failing test**

Create or append to `container/agent-runner/src/providers/codex-app-server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeCodexConfigToml } from './codex-app-server.js';

let tmpHome: string;
let savedHome: string | undefined;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-test-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
  configPath = path.join(tmpHome, '.codex', 'config.toml');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('writeCodexConfigToml — codex provider', () => {
  it('emits [model_providers.openai] block plus top-level model / model_provider', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'codex',
      model: 'gpt-5-mini',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.openai]');
    expect(toml).toContain('name = "openai"');
    expect(toml).toContain('base_url = "http://host.docker.internal:3001/openai/v1"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('model = "gpt-5-mini"');
    expect(toml).toContain('model_provider = "openai"');
    expect(toml).not.toContain('[model_providers.omlx]');
  });
});

describe('writeCodexConfigToml — local provider', () => {
  it('emits [model_providers.omlx] block plus top-level model / model_provider', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'local',
      model: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.omlx]');
    expect(toml).toContain('name = "omlx"');
    expect(toml).toContain('base_url = "http://host.docker.internal:3001/omlx/v1"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).toContain('env_key = "OMLX_API_KEY"');
    expect(toml).toContain('model = "Qwen3.6-35B-A3B-UD-MLX-4bit"');
    expect(toml).toContain('model_provider = "omlx"');
    expect(toml).not.toContain('[model_providers.openai]');
  });
});

describe('writeCodexConfigToml — mcp servers still emitted', () => {
  it('writes both [mcp_servers.*] and the active [model_providers.*] in one file', () => {
    writeCodexConfigToml({
      mcpServers: {
        nanoclaw: { command: '/usr/bin/bun', args: ['run', '/app/src/mcp.ts'], env: { FOO: 'bar' } },
      },
      activeProvider: 'codex',
      model: 'gpt-5-mini',
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.nanoclaw]');
    expect(toml).toContain('[model_providers.openai]');
    expect(toml).toContain('FOO = "bar"');
  });
});

describe('writeCodexConfigToml — model omitted', () => {
  it('still emits [model_providers.<name>] block when no model is set', () => {
    writeCodexConfigToml({
      mcpServers: {},
      activeProvider: 'local',
      model: undefined,
      proxyBaseUrl: 'http://host.docker.internal:3001',
    });
    const toml = fs.readFileSync(configPath, 'utf8');
    expect(toml).toContain('[model_providers.omlx]');
    // model_provider must still be set so codex routes to omlx
    expect(toml).toContain('model_provider = "omlx"');
    // model line is omitted when not set — codex falls back to its own default
    expect(toml).not.toMatch(/^model = /m);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd container/agent-runner && bun test src/providers/codex-app-server.test.ts`
Expected: FAIL — `writeCodexConfigToml` doesn't exist yet.

- [ ] **Step 4: Implement the refactor**

Edit `container/agent-runner/src/providers/codex-app-server.ts`. Replace the existing `writeCodexMcpConfigToml` (lines 358-389) with a new combined writer:

```ts
// ── Codex config.toml ───────────────────────────────────────────────────────
// Codex reads ~/.codex/config.toml at startup. We rewrite it on every spawn
// to reflect (a) the MCP servers the agent-runner needs and (b) the active
// model_providers block routing codex's outbound HTTP through the credential
// proxy. The two responsibilities share one file, so they're written together
// to avoid the "second writer clobbers the first" trap.
//
// Why `wire_api = "chat"`: the default `responses` wire protocol opens a
// WebSocket to the provider, which mlx-omni-server (and any other local
// OpenAI-compat server that only implements REST) rejects with 401. Forcing
// the chat-completions transport keeps the codex container compatible with
// every OpenAI-shaped backend.

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodexConfigTomlInput {
  /** MCP servers to emit as `[mcp_servers.<name>]` blocks. */
  mcpServers: Record<string, CodexMcpServer>;
  /**
   * Active provider — `codex` (cloud OpenAI via proxy /openai/v1) or `local`
   * (mlx-omni-server via proxy /omlx/v1). Other values fall through to
   * `codex` so unknown providers default to the safer cloud path.
   */
  activeProvider: 'codex' | 'local' | string;
  /** Top-level `model = ...`. Omitted from output when undefined. */
  model: string | undefined;
  /**
   * Credential-proxy base URL (e.g. `http://host.docker.internal:3001`).
   * The `/openai/v1` or `/omlx/v1` suffix is appended based on activeProvider.
   */
  proxyBaseUrl: string;
}

interface ProviderBlockSpec {
  /** TOML table name and codex's `model_provider = "..."` value. */
  name: 'openai' | 'omlx';
  /** Path suffix added to the proxy base URL. */
  proxyPathSuffix: string;
  /** Container env var carrying the placeholder bearer token. */
  envKey: 'OPENAI_API_KEY' | 'OMLX_API_KEY';
}

function providerBlockSpec(activeProvider: string): ProviderBlockSpec {
  if (activeProvider === 'local') {
    return { name: 'omlx', proxyPathSuffix: '/omlx/v1', envKey: 'OMLX_API_KEY' };
  }
  return { name: 'openai', proxyPathSuffix: '/openai/v1', envKey: 'OPENAI_API_KEY' };
}

export function writeCodexConfigToml(input: CodexConfigTomlInput): void {
  const codexConfigDir = path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  const lines: string[] = [];

  // 1. MCP servers (preserve existing behavior verbatim).
  for (const [name, config] of Object.entries(input.mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push('type = "stdio"');
    lines.push(`command = ${tomlBasicString(config.command)}`);
    if (config.args && config.args.length > 0) {
      const argsStr = config.args.map(tomlBasicString).join(', ');
      lines.push(`args = [${argsStr}]`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${tomlBasicString(value)}`);
      }
    }
    lines.push('');
  }

  // 2. Active model_providers block — only the one for activeProvider.
  const spec = providerBlockSpec(input.activeProvider);
  const baseUrl = `${input.proxyBaseUrl.replace(/\/+$/, '')}${spec.proxyPathSuffix}`;
  lines.push(`[model_providers.${spec.name}]`);
  lines.push(`name = ${tomlBasicString(spec.name)}`);
  lines.push(`base_url = ${tomlBasicString(baseUrl)}`);
  lines.push('wire_api = "chat"');
  lines.push(`env_key = ${tomlBasicString(spec.envKey)}`);
  lines.push('');

  // 3. Top-level model + model_provider routing.
  if (input.model) {
    lines.push(`model = ${tomlBasicString(input.model)}`);
  }
  lines.push(`model_provider = ${tomlBasicString(spec.name)}`);
  lines.push('');

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(
    `Wrote codex config.toml (${Object.keys(input.mcpServers).length} mcp server(s), ` +
      `provider=${spec.name}, model=${input.model ?? '(default)'})`,
  );
}

/** @deprecated — use writeCodexConfigToml. Kept temporarily so any future
 *  out-of-tree caller doesn't break silently. Will be removed once trunk
 *  callers are updated. */
export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  writeCodexConfigToml({
    mcpServers: servers,
    activeProvider: 'codex',
    model: undefined,
    proxyBaseUrl: 'http://host.docker.internal:3001',
  });
}
```

- [ ] **Step 5: Update the call site in codex.ts**

Edit `container/agent-runner/src/providers/codex.ts`:

Update the import block (around line 32):
```ts
import {
  type AppServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexConfigToml,
} from './codex-app-server.js';
```

Replace the call at line 197:
```ts
// OLD: writeCodexMcpConfigToml(self.mcpServers);

// NEW — read container.json to find active provider + model:
const containerJsonPath = '/workspace/agent/container.json';
const containerJson = fs.existsSync(containerJsonPath)
  ? (JSON.parse(fs.readFileSync(containerJsonPath, 'utf-8')) as { provider?: string; model?: string })
  : {};
const proxyBaseUrl = (process.env.OPENAI_BASE_URL ?? 'http://host.docker.internal:3001/openai/v1')
  .replace(/\/(openai|omlx)\/v1$/, '');
writeCodexConfigToml({
  mcpServers: self.mcpServers,
  activeProvider: containerJson.provider ?? 'codex',
  model: containerJson.model ?? self.model,
  proxyBaseUrl,
});
```

- [ ] **Step 6: Run tests**

Run: `cd container/agent-runner && bun test src/providers/codex-app-server.test.ts`
Expected: PASS (all 4 describe blocks).

Run the container typecheck so the renamed export doesn't break anywhere else:
```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/providers/codex-app-server.ts \
        container/agent-runner/src/providers/codex.ts \
        container/agent-runner/src/providers/codex-app-server.test.ts
git commit -m "$(cat <<'EOF'
feat(codex): emit [model_providers.<name>] in config.toml

writeCodexConfigToml (renamed from writeCodexMcpConfigToml) now writes
both MCP servers and the active model_providers block (openai for
codex, omlx for local) in one config.toml. Forces wire_api="chat" so
mlx-omni-server's REST-only API responds.
EOF
)"
```

---

## Task 5: Drop `openaiBackend`, route by `agent_provider`

**Goal:** Remove the redundant `openaiBackend` axis. Container-runner picks `/openai/v1` vs `/omlx/v1` directly from the resolved provider name.

**Files:**
- Modify: `src/container-config.ts:74` (drop field from interface)
- Modify: `src/container-config.ts:118` (drop field from reader)
- Modify: `src/container-runner.ts:494-498` (replace openaiBackend check with provider check)

- [ ] **Step 1: Drop `openaiBackend` from the ContainerConfig interface**

Edit `src/container-config.ts`. Remove lines 59-75 (the `openaiBackend` JSDoc block + field). The interface now ends at `allowedModels` and immediately closes:

```ts
  allowedModels?: { provider: string; model: string }[];
}
```

Also remove the corresponding line in `readContainerConfig` (around line 118): drop the `openaiBackend: raw.openaiBackend,` line entirely.

- [ ] **Step 2: Route proxy prefix by provider in container-runner**

Edit `src/container-runner.ts:494-498`. Replace the openaiBackend check:

```ts
// OLD:
// const openaiPrefix = containerConfig.openaiBackend === 'omlx' ? '/omlx/v1' : '/openai/v1';

// NEW:
// OpenAI traffic routes through one of two proxy prefixes per the group's
// active provider: `codex` (cloud OpenAI) → /openai/v1, `local`
// (mlx-omni-server) → /omlx/v1. The proxy strips the prefix and substitutes
// the appropriate API key per upstream.
const openaiPrefix = provider === 'local' ? '/omlx/v1' : '/openai/v1';
```

The `provider` variable is already resolved upstream at line 132 (via `resolveProviderContribution`) and threaded into `buildContainerArgs` at line 475.

- [ ] **Step 3: Run host tests + typecheck**

```bash
pnpm run build
pnpm test
```

Expected: PASS. If any test referenced `openaiBackend`, the typecheck will surface that and the test should be updated to use `agent_provider` / `provider` directly.

- [ ] **Step 4: Ensure .env has the omlx settings**

Run:
```bash
grep -q '^OMLX_API_KEY=' .env || echo 'OMLX_API_KEY=godfrey' >> .env
grep -q '^OMLX_BASE_URL=' .env || echo 'OMLX_BASE_URL=http://localhost:8000' >> .env
```

- [ ] **Step 5: Restart the host so the proxy picks up env**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

(macOS — for Linux: `systemctl --user restart nanoclaw`)

- [ ] **Step 6: Smoke-test the /omlx route end-to-end (manual)**

```bash
curl -s -H "Authorization: Bearer placeholder" http://127.0.0.1:3001/omlx/v1/models | head -c 400
```

Expected: A JSON `{ "data": [...] }` listing whatever models mlx-omni-server has loaded. The proxy substitutes the real bearer (`godfrey`) before forwarding, so `placeholder` in the request is fine.

If you see a 502 or empty body: `mlx-omni-server` isn't running on `localhost:8000`, or its bearer expectation doesn't match `OMLX_API_KEY`. Start it: `mlx-omni-server --port 8000 --api-key godfrey` (or whatever the binary's flag name is — adjust to your install).

- [ ] **Step 7: Commit**

```bash
git add src/container-config.ts src/container-runner.ts .env
git commit -m "$(cat <<'EOF'
feat(container-runner): route OpenAI traffic by provider, drop openaiBackend

Provider 'local' picks /omlx/v1; 'codex' picks /openai/v1. The separate
openaiBackend axis is removed — agent_provider is the single source of
truth. .env gains OMLX_API_KEY/OMLX_BASE_URL.
EOF
)"
```

Note: this commit stages `.env` only if it has new keys — review the staged diff first. If `.env` is gitignored (it should be), the changes stay local; remove `.env` from the `git add` line.

---

## Task 6: Extend playground Models API to include `local` discovery

**Goal:** `/api/drafts/:folder/models` returns discovered models from `local` as well as `claude` and `codex`.

**Files:**
- Modify: `src/channels/playground/api/models.ts`
- Modify: `src/channels/playground/api/models.test.ts` (if exists)

- [ ] **Step 1: Inspect the existing test**

Run: `ls src/channels/playground/api/models.test.ts 2>/dev/null && cat src/channels/playground/api/models.test.ts | head -60`

If it exists and asserts the discovery list contains specific providers, update Step 3.

- [ ] **Step 2: Widen the discovered-provider type and discovery fan-out**

Edit `src/channels/playground/api/models.ts`:

```ts
// Widen the DiscoveredModel union:
export interface DiscoveredModel {
  provider: 'claude' | 'codex' | 'local';
  id: string;
}

// Inside handleGetModels, replace the existing parallel-fetch block:
const [claudeHints, codexHints, localHints] = await Promise.all([
  listAllForProvider('claude').catch(() => []),
  listAllForProvider('codex').catch(() => []),
  listAllForProvider('local').catch(() => []),
]);
const catalogIds = new Set(catalog.map((m) => `${m.provider}:${m.id}`));
const discovered: DiscoveredModel[] = [];
for (const h of claudeHints) {
  if (!catalogIds.has(`claude:${h.id}`)) discovered.push({ provider: 'claude', id: h.id });
}
for (const h of codexHints) {
  if (!catalogIds.has(`codex:${h.id}`)) discovered.push({ provider: 'codex', id: h.id });
}
for (const h of localHints) {
  if (!catalogIds.has(`local:${h.id}`)) discovered.push({ provider: 'local', id: h.id });
}
```

- [ ] **Step 3: Update test (if it exists)**

If `models.test.ts` exists, ensure it doesn't fail on the new `local` entries. Likely the test uses a fixture that doesn't speak `/v1/models`, so `localHints` will be empty — no new assertions needed. If the test inspects the `DiscoveredModel` type union, update it to include `'local'`.

- [ ] **Step 4: Run tests**

```bash
pnpm test src/channels/playground/api/models.test.ts || pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/playground/api/models.ts src/channels/playground/api/models.test.ts
git commit -m "$(cat <<'EOF'
feat(playground/models): discover models from 'local' provider

Models tab now surfaces mlx-omni-server's /v1/models alongside cloud
providers. listAllForProvider('local') hits the omlx adapter registered
in Task 1.
EOF
)"
```

---

## Task 7: Three-section Models tab UI (Claude / Codex / Local)

**Goal:** The playground Models tab groups cards by provider into three sections. The Local section shows a server-status pill. Whitelist toggling stays a checkbox; promoting a model to active uses a separate "Use now" button. Cross-provider "Use now" flips `agent_provider` as well.

**Files:**
- Modify: `src/channels/playground/public/tabs/models.js`
- Modify: `src/channels/playground/public/styles.css` (or wherever `.models-section-title` lives — grep first)

- [ ] **Step 1: Inspect existing CSS hooks**

```bash
grep -rn 'model-card\|model-grid\|models-section-title\|active-badge\|status-online\|status-offline' src/channels/playground/public/ | head -20
```

This tells you which classes already exist and which need new CSS. The current file uses `.model-card`, `.model-grid`, `.models-section-title`, `.status`, `.status-online`, `.status-offline`. We will reuse all of those and add: `.model-section`, `.model-section-header`, `.model-section-status`, `.model-card .use-now-btn`, `.model-card.active`.

- [ ] **Step 2: Rewrite the Models tab template**

Edit `src/channels/playground/public/tabs/models.js`. Replace the top-level `el.innerHTML = ...` block in `mountModels` and the body of `renderGrid` with a three-section layout. Replace from line 11 through line 79 with:

```js
export function mountModels(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="models-layout">
      <header class="models-header">
        <h3>Lock in which models your agent can use</h3>
        <p class="hint">💡 Local models cost $0 per token but spend your hardware. Cloud models cost real money but are faster on commodity laptops.</p>
      </header>

      <section class="model-section" data-provider="claude">
        <header class="model-section-header">
          <h4 class="models-section-title">Claude (Anthropic)</h4>
        </header>
        <div class="model-grid" data-grid="claude"></div>
      </section>

      <section class="model-section" data-provider="codex">
        <header class="model-section-header">
          <h4 class="models-section-title">Codex (OpenAI)</h4>
        </header>
        <div class="model-grid" data-grid="codex"></div>
      </section>

      <section class="model-section" data-provider="local">
        <header class="model-section-header">
          <h4 class="models-section-title">Local (your hardware)</h4>
          <span class="model-section-status" id="local-server-status">checking…</span>
        </header>
        <div class="model-grid" data-grid="local"></div>
      </section>
    </div>
  `;

  loadModels(el, folder);
}

function loadModels(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], discovered: [], allowedModels: [], activeModel: null }))
    .then((data) => {
      catalogCache = data.catalog || [];
      discoveredCache = data.discovered || [];
      allowedModelsCache = data.allowedModels || [];
      activeModel = data.activeModel || null;
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
      renderSections(el);
      pollLocalServer(el);
    });
}

function renderSections(el) {
  for (const provider of ['claude', 'codex', 'local']) {
    const grid = el.querySelector(`[data-grid="${provider}"]`);
    grid.innerHTML = '';

    const curated = catalogCache.filter((m) => m.provider === provider);
    const discovered = discoveredCache.filter((d) => d.provider === provider);

    if (curated.length === 0 && discovered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column: 1 / -1; padding: 12px;">No ${provider} models available. ${
        provider === 'local'
          ? 'Start mlx-omni-server on localhost:8000.'
          : `Add a provider key (${provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}) to .env.`
      }</div>`;
      continue;
    }

    for (const m of curated) {
      grid.appendChild(buildCard(m));
    }
    for (const d of discovered) {
      grid.appendChild(buildDiscoveredCard(d));
    }
  }
}
```

- [ ] **Step 3: Add active-state + Use-now affordance to card builders**

In the same file, replace `buildCard` and `buildDiscoveredCard` so they render:
1. The whitelist checkbox (existing behavior).
2. An "Active" badge when `activeModel` matches.
3. A "Use now" button on whitelisted, non-active cards.

```js
function isActive(model) {
  return activeModel && activeModel.provider === model.provider && activeModel.model === (model.id || model.model);
}

function buildCard(m) {
  const card = document.createElement('div');
  card.className = `model-card origin-${m.origin || 'cloud'}`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === m.provider && a.model === m.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: m.provider, model: m.id })) card.classList.add('active');

  const chipsHtml = (m.chips || []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  const costLine = m.costPer1kTokensUsd != null ? `$${m.costPer1kTokensUsd} / 1k tokens` : '$0 (local)';
  const latencyLine = m.avgLatencySec != null ? `${m.avgLatencySec}s avg` : '? s';
  const paramsLine = `params: ${escapeHtml(m.paramCount || '?')}`;
  const modalitiesLine = `modalities: ${(m.modalities || ['?']).join(' + ')}`;
  const notes = m.notes ? `<div class="notes">📝 ${escapeHtml(m.notes)}</div>` : '';

  let localExtras = '';
  if (m.origin === 'local') {
    localExtras = `
      <div class="local-extras">
        ${m.host ? `host: <code>${escapeHtml(m.host)}</code><br>` : ''}
        ${m.contextSize ? `context: ${m.contextSize} · ` : ''}${
          m.quantization ? `quantization: ${escapeHtml(m.quantization)}` : ''
        }
      </div>`;
  }

  const activeBadge = isActive({ provider: m.provider, model: m.id })
    ? `<span class="active-badge">● Active</span>`
    : '';
  const useNowBtn =
    isAllowed && !isActive({ provider: m.provider, model: m.id })
      ? `<button class="use-now-btn" type="button">Use now</button>`
      : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(m.displayName || m.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${costLine} · ${latencyLine}</div>
    <div class="meta-line">${paramsLine} · ${modalitiesLine}</div>
    ${localExtras}
    ${notes}
    ${useNowBtn}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: m.provider, id: m.id }, e.target.checked, card);
  });
  const btn = card.querySelector('.use-now-btn');
  if (btn) {
    btn.addEventListener('click', () => useNow({ provider: m.provider, model: m.id }));
  }
  return card;
}

function buildDiscoveredCard(d) {
  const card = document.createElement('div');
  card.className = `model-card origin-${d.provider === 'local' ? 'local' : 'cloud'} model-card-discovered`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === d.provider && a.model === d.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: d.provider, model: d.id })) card.classList.add('active');

  const providerChip =
    d.provider === 'claude' ? '☁ Anthropic' : d.provider === 'codex' ? '☁ OpenAI' : '💻 local';
  const activeBadge = isActive({ provider: d.provider, model: d.id })
    ? `<span class="active-badge">● Active</span>`
    : '';
  const useNowBtn =
    isAllowed && !isActive({ provider: d.provider, model: d.id })
      ? `<button class="use-now-btn" type="button">Use now</button>`
      : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(d.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips"><span class="chip">${escapeHtml(providerChip)}</span></div>
    <div class="meta-line muted">No curated metadata — bare model id from the provider's /v1/models.</div>
    ${useNowBtn}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: d.provider, id: d.id }, e.target.checked, card);
  });
  const btn = card.querySelector('.use-now-btn');
  if (btn) {
    btn.addEventListener('click', () => useNow({ provider: d.provider, model: d.id }));
  }
  return card;
}
```

- [ ] **Step 4: Implement `useNow`**

Add to `models.js`:

```js
async function useNow({ provider, model }) {
  const folder = window.__pg.agent.folder;
  try {
    const r = await fetch(`/api/drafts/${folder}/active-model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ provider, model }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    activeModel = { provider, model };
    // Re-render so badges + Use-now buttons reposition.
    const el = document.querySelector('.models-layout').parentElement;
    renderSections(el);
    showDraftBanner(`Active model: ${model} (${provider}).`);
  } catch (err) {
    console.error('useNow failed', err);
  }
}
```

- [ ] **Step 5: Implement the `/api/drafts/:folder/active-model` PUT route**

Edit `src/channels/playground/api/models.ts`. Add a new handler:

```ts
export function handlePutActiveModel(
  draftFolder: string,
  body: { provider?: unknown; model?: unknown },
): ApiResult<{ ok: true; activeModel: { provider: string; model: string } }> {
  if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
    return { status: 400, body: { error: 'provider and model are required strings' } };
  }
  const provider = body.provider;
  const model = body.model;
  try {
    const cfg = readContainerConfig(draftFolder);
    cfg.provider = provider;
    cfg.model = model;
    writeContainerConfig(draftFolder, cfg);
    return { status: 200, body: { ok: true, activeModel: { provider, model } } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
```

And include `activeModel` in `handleGetModels`'s response. Update the `ModelsResponse` interface and the return body:

```ts
export interface ModelsResponse {
  catalog: ModelEntry[];
  discovered: DiscoveredModel[];
  allowedModels: { provider: string; model: string }[];
  activeModel: { provider: string; model: string } | null;
}

// In handleGetModels, before return:
const activeModel = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;
return {
  status: 200,
  body: { catalog, discovered, allowedModels: cfg.allowedModels ?? [], activeModel },
};
```

- [ ] **Step 6: Wire the new route**

Find where `handlePutModels` is registered. Run:
```bash
grep -n 'handlePutModels\|handleGetModels' src/channels/playground/api-routes.ts
```

In `api-routes.ts`, alongside the existing `PUT /api/drafts/:folder/models` registration, add `PUT /api/drafts/:folder/active-model` that calls `handlePutActiveModel`. Mirror the surrounding pattern exactly — the file shows the router-registration idiom this app uses.

- [ ] **Step 7: Implement the local-server status poll**

Add to `models.js` (replacing the existing `pollLocalStatus` — that one polled per-card; we move it to a single section-level probe):

```js
async function pollLocalServer(el) {
  const statusEl = el.querySelector('#local-server-status');
  if (!statusEl) return;
  try {
    // mlx-omni-server's /v1/models is the cheapest reachability check.
    // We use no-cors so the browser doesn't choke on a missing CORS header;
    // a resolved fetch with mode:'no-cors' tells us only "the host responded",
    // which is exactly what we need to render online/offline.
    await fetch('http://localhost:8000/v1/models', { method: 'GET', mode: 'no-cors' });
    statusEl.textContent = '● online';
    statusEl.className = 'model-section-status status-online';
  } catch {
    statusEl.textContent = '○ offline — start mlx-omni-server on :8000';
    statusEl.className = 'model-section-status status-offline';
  }
}
```

- [ ] **Step 8: Add CSS for the new visual states**

Run `grep -n 'model-section-title\|status-online\|status-offline' src/channels/playground/public/styles.css` to find the right insertion point. Append:

```css
.model-section { margin-bottom: 24px; }
.model-section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.model-section-status { font-size: 13px; padding: 2px 8px; border-radius: 4px; }
.model-section-status.status-online { color: #1a7a1a; background: #e6f5e6; }
.model-section-status.status-offline { color: #8a4b00; background: #fff3e0; }

.model-card.active { box-shadow: 0 0 0 2px #1a7a1a; }
.active-badge { margin-left: auto; font-size: 12px; color: #1a7a1a; font-weight: 600; }
.use-now-btn {
  margin-top: 8px;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid #1a7a1a;
  background: #fff;
  color: #1a7a1a;
  border-radius: 4px;
  cursor: pointer;
}
.use-now-btn:hover { background: #e6f5e6; }
```

- [ ] **Step 9: Manual UI verification**

The `pnpm test` suite does not cover the playground's static JS. To verify:

1. Restart the host: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
2. Mint a playground URL for any test agent group (use an existing `class_login_tokens` row or `/playground` skill).
3. Hard-refresh in Chrome (⌘⇧R).
4. Open the Models tab. Confirm:
   - Three sections render: Claude, Codex, Local.
   - The Local section's status pill says "online" (assuming mlx-omni-server is running) or "offline" with the prompt to start the server.
   - Curated cards in each section render correctly.
   - Discovered cards (bare ids) render below curated.
   - Checking a card adds it to the whitelist (the existing toggleModel still works).
   - On a whitelisted, non-active card a "Use now" button appears.
   - Clicking "Use now" updates the active badge and persists across reload (check by reloading and confirming the Active badge still appears on the same card).

- [ ] **Step 10: Commit**

```bash
git add src/channels/playground/public/tabs/models.js \
        src/channels/playground/public/styles.css \
        src/channels/playground/api/models.ts \
        src/channels/playground/api-routes.ts
git commit -m "$(cat <<'EOF'
feat(playground/models): three sections + active-model affordance

Models tab now groups cards by provider (Claude / Codex / Local), with
a Local-server status pill and a per-card 'Use now' button that promotes
a whitelisted model to active. Cross-provider promotion also flips the
agent's provider via the new PUT /api/drafts/:folder/active-model.
EOF
)"
```

---

## Task 8: End-to-end smoke test with a real `local` agent

**Goal:** Prove the full path: pick Qwen3.6 in the Models tab → agent's container respawns on `local` provider → message sent via Telegram routes through `/omlx/v1` → reply comes back.

**Files:** None — operational verification.

- [ ] **Step 1: Pick a test agent group**

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, folder, name FROM agent_groups WHERE folder LIKE 'student%' OR folder LIKE 'cli%' ORDER BY created_at DESC LIMIT 5"
```

Pick one you're OK turning over to local for this test (e.g. `cli-with-chip` if it's a sandbox, or any `student_0X`).

- [ ] **Step 2: Confirm mlx-omni-server is up**

```bash
curl -sf -H "Authorization: Bearer godfrey" http://localhost:8000/v1/models | head -c 400
```

Expected: `{"data":[...]}` with the loaded model ids. If empty / connection refused: `mlx-omni-server --port 8000 --api-key godfrey` (or your launcher).

- [ ] **Step 3: Set the active model via the playground**

Open the agent's playground, Models tab → click Qwen3.6's "Use now". (If the playground isn't set up for this group, set it directly:)

```bash
GROUP_FOLDER=cli-with-chip  # or whatever you picked
pnpm exec tsx -e "
  import { readContainerConfig, writeContainerConfig } from './src/container-config.js';
  const cfg = readContainerConfig('$GROUP_FOLDER');
  cfg.provider = 'local';
  cfg.model = 'Qwen3.6-35B-A3B-UD-MLX-4bit';
  writeContainerConfig('$GROUP_FOLDER', cfg);
  console.log('done');
"
```

- [ ] **Step 4: Sync agent_groups + sessions tables to match**

Otherwise `/model` and any DB-driven check will still see the old provider:

```bash
pnpm exec tsx -e "
  import { setProvider } from './src/provider-switch.js';
  console.log(setProvider('$GROUP_FOLDER', 'local'));
"
```

- [ ] **Step 5: Send a test message via Telegram**

DM the agent something tiny like "Say hello and tell me what model you are." Watch:

```bash
tail -f logs/nanoclaw.log
```

Expected log lines:
- `Spawning container ... agentGroup: <name>`
- The proxy line shows requests hitting `/omlx/v1/chat/completions` (set log level to debug if not visible).
- The agent replies on Telegram within ~15-30s (Qwen3.6 at 4-bit on Apple Silicon).

- [ ] **Step 6: Diagnose failures**

If the reply doesn't come:
- `tail -n 200 logs/nanoclaw.error.log` — proxy 502s, container spawn errors, OAuth refresh errors.
- `pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/sessions/<sid>/outbound.db "SELECT id, status, created_at FROM messages_out ORDER BY created_at DESC LIMIT 3"` — see whether the agent ever produced a reply.
- `cat ~/.codex/config.toml` is **inside the container** — to inspect what the runner wrote, exec into a still-running container with `container exec <name> cat /home/node/.codex/config.toml` (Apple Container), confirming `[model_providers.omlx]` and `model_provider = "omlx"` are present.
- Container exited too fast? Run `container logs <name>` immediately after spawn (logs are lost on `--rm` exit, so capture quickly or temporarily drop `--rm` in `container-runner.ts:479`).

- [ ] **Step 7: Document the smoke test**

Update task #12 (`Smoke test 2 students end-to-end`) in the task list — either close it as complete or note that the local-provider variant works. No commit needed; this is a TaskUpdate.

---

## Self-review summary

- **Spec coverage:** All seven sections of the design spec map to tasks:
  - §1 Goal — narrative, no task (intentional).
  - §2 Three-tier provider model — Tasks 2 (`/provider` hint), 5 (drop openaiBackend, route by provider).
  - §3 Container codex config.toml — Task 4.
  - §4 Credential-proxy /omlx/* — verified in Task 5 Step 6 (already implemented in trunk).
  - §5 Models tab UX — Task 7 (covers section grouping, status pill, whitelist toggle, active-state, "Use now" with cross-provider flip).
  - §6 Catalog + omlx discovery adapter — Tasks 1 and 3.
  - §7 Out of scope — captured in the spec; no tasks.
- **Placeholder scan:** No "TBD", "TODO", "etc." in code/test steps. Each test step has full code; each implementation step has full code or a clear minimal diff with line numbers.
- **Type consistency:** `writeCodexConfigToml`'s `CodexConfigTomlInput` is the same shape in Task 4 Step 2 (test), Step 4 (impl), and Step 5 (call site). `DiscoveredModel.provider` is widened consistently across Tasks 6 and 7. The `activeModel` field is added to `ModelsResponse` in Task 7 Step 5 and read in Task 7 Step 2's `loadModels`.
- **Open assumption flagged:** Task 7 Step 6 assumes `api-routes.ts` follows a consistent registration idiom. If a code reading shows otherwise, the implementer should grep for `handlePutModels` and mirror its exact integration pattern (not invent a new one).
