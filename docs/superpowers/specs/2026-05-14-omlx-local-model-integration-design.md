# omlx Local Model Integration — Design

**Date:** 2026-05-14
**Status:** approved (brainstorming) → ready for plan
**Scope:** Add a local mlx-omni-server backend as a peer to Claude and OpenAI/Codex, addressable per-agent and surfaceable in the playground Models tab. Driven by the classroom pedagogy goal: students see what "running a local model" means side-by-side with cloud providers.

## 1. Goal and motivation

The instructor runs `mlx-omni-server` on port 8000 of the host with at least one model loaded (Qwen3.6-35B-A3B-UD-MLX-4bit and others). Students should be able to:

- Read about local models in the playground Models tab next to Claude and OpenAI cards.
- Pick a local model for their agent. The agent's container then routes its codex traffic to the local server instead of the cloud OpenAI endpoint.
- Switch between providers (claude / codex / local) and within a provider's models via `/provider` and `/model` admin commands on Telegram.

This is for **teaching**. The classroom shares one local server (no per-student MLX servers). Cost is incidental: the curriculum value is the contrast.

## 2. Three-tier provider model

NanoClaw's existing agent dispatcher has one `provider` axis on each agent group:
- `claude` — Anthropic Claude (Agent SDK)
- `codex` — OpenAI codex-style (codex-app-server)
- `local` — **new** — codex-app-server pointed at a local OpenAI-compatible server

`local` is not a backend axis on top of `codex`. It is a peer provider. The same codex container code runs, but the model-providers entry in `~/.codex/config.toml` points at `http://host.docker.internal:3001/omlx/v1` instead of `/openai/v1`.

This means:
- `agent_groups.agent_provider` accepts `'local'`.
- `/provider` admin command lists `claude | codex | local` (Telegram).
- `/model` admin command, when the agent is on `local`, lists models discovered from omlx (`/v1/models`).
- The playground Models tab groups whitelist entries into three sections: Claude / Codex / Local.

### container.json shape

`allowedModels` becomes a list of typed entries:

```jsonc
{
  "allowedModels": [
    { "provider": "claude", "model": "claude-haiku-4-5" },
    { "provider": "codex",  "model": "gpt-5-mini" },
    { "provider": "local",  "model": "Qwen3.6-35B-A3B-UD-MLX-4bit" }
  ]
}
```

The `openaiBackend` field added earlier is removed. Backend selection follows `agent_provider` directly: `local` → omlx route, `codex` → cloud OpenAI route. No separate axis.

## 3. Container codex config.toml

Inside the agent container, codex-app-server reads `~/.codex/config.toml`. The container-runner writes this file at session start. The shape depends on the agent's current provider:

**When provider is `codex`:**
```toml
[model_providers.openai]
name = "openai"
base_url = "http://host.docker.internal:3001/openai/v1"
wire_api = "chat"
env_key = "OPENAI_API_KEY"

model = "gpt-5-mini"
model_provider = "openai"
```

**When provider is `local`:**
```toml
[model_providers.omlx]
name = "omlx"
base_url = "http://host.docker.internal:3001/omlx/v1"
wire_api = "chat"
env_key = "OMLX_API_KEY"

model = "Qwen3.6-35B-A3B-UD-MLX-4bit"
model_provider = "omlx"
```

`wire_api = "chat"` avoids the responses-API WebSocket path (which previously caused 401 loops on local servers). Only the active provider's block is emitted. Cross-provider switches restart the container (existing pattern from `provider-switch.ts`), so the config.toml is rewritten at the next spawn — no need to maintain both blocks.

Implementation point: extend `writeCodexMcpConfigToml` in `container/agent-runner/src/providers/codex-app-server.ts` to take the active provider as a parameter and emit the corresponding `[model_providers.<name>]` block plus top-level `model` / `model_provider`. The placeholder env vars (`OPENAI_API_KEY=placeholder`, `OMLX_API_KEY=placeholder`) are already set on every codex/local container at spawn time — codex-app-server only requires them to be present, not real.

## 4. Credential proxy /omlx/* route

`src/credential-proxy.ts` already multiplexes by path prefix. Add a third route:

- `/openai/*` → strip prefix, replace `Authorization` header with `Bearer <OPENAI_API_KEY>`, forward to `api.openai.com` (or `OPENAI_BASE_URL` override).
- `/omlx/*` → strip prefix, replace `Authorization` header with `Bearer <OMLX_API_KEY || "local">`, forward to `OMLX_BASE_URL` (default `http://localhost:8000`).

Env vars read at proxy startup (added to `readEnvFile([...])`):
- `OMLX_API_KEY` — defaults to `"local"` if unset (mlx-omni-server's default when no key configured).
- `OMLX_BASE_URL` — defaults to `http://localhost:8000`.

The container reaches the host's proxy on `host.docker.internal:3001`; the proxy then reaches the omlx server on localhost. mlx-omni-server doesn't need to be exposed beyond loopback.

## 5. Models tab UX

The Models tab in the playground (`src/channels/playground/public/tabs/models.js`) gets three sections instead of one flat grid:

```
Claude
  [card]  [card]  [card]
Codex (OpenAI)
  [card]  [card]
Local
  [card]  [card]  [card]   ← server status pill (running / offline)
```

Each section pulls from the catalog filtered by `provider`, augmented with discovery results from `model-discovery.listAllForProvider(name)`. Card state is two-tiered:

- **Whitelisted** (checkbox-style indicator): the model is in the agent's `allowedModels` and therefore routable via `/model`.
- **Active** (filled "Active" badge): the model is currently in use — matches `container.json` `model` + `provider`. Exactly one card is Active across the whole tab.

Selecting a card toggles whitelist membership. A separate "Use now" affordance on a whitelisted card promotes it to Active (and, if cross-provider, also flips `agent_provider`).

User experience clarifications (resolved during brainstorming):
- The Models tab is **informational + whitelist gate**. It shows specs/chips/cost. Selecting cards adds to the whitelist; it doesn't directly switch the live model.
- `/model` on Telegram switches the live model **within the current provider** only. Cross-provider switches go through `/provider`. This keeps each command predictable — `/model` shows you the model list for whatever provider you're on, picks one of those.
- Choosing a Local card flips both `agent_provider` to `local` and the active model in one go (implicit provider switch). This matches the student mental model: "I picked Qwen, so my agent is now local."

The "Local" section shows a status indicator: green pill ("running") if `OMLX_BASE_URL` `/v1/models` responds with 200, gray ("offline") otherwise. Probed at page load and via Models-tab refresh; no continuous polling.

## 6. Model catalog and mlx-omni discovery adapter

### Catalog (hand-written baseline)

Add one entry to `src/model-catalog.ts`. Rename `CLOUD_ENTRIES` to `BUILTIN_ENTRIES` and add the Qwen3.6 entry there. The existing `readLocalEntries()` path (`model-catalog-local.json`) stays — instructors can still add or override entries via that file without touching source. The Qwen3.6 entry is the only built-in `local` model; everything else discovered from omlx surfaces as bare-id cards via discovery, not catalog:

```ts
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
  host: 'localhost:8000',
  contextSize: 32768,
  quantization: 'MLX 4-bit',
  chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
  bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
}
```

### Discovery adapter

Add `src/model-providers/omlx.ts` alongside `anthropic.ts` and `openai.ts`. Mirrors the existing adapter shape:

```ts
import { readEnvFile } from '../env.js';
import type { AuthHeader, ModelHint, ModelProviderAdapter, ParsedModel } from './types.js';

const STATIC_FALLBACK: ModelHint[] = [
  { id: 'Qwen3.6-35B-A3B-UD-MLX-4bit', alias: 'qwen', note: 'MLX 4-bit, ~35B' },
];

function getAuth(): AuthHeader | null {
  const env = readEnvFile(['OMLX_API_KEY']);
  const key = env.OMLX_API_KEY ?? 'local';
  return { name: 'authorization', value: `Bearer ${key}` };
}

function parseId(id: string): ParsedModel {
  return { id, alias: id, rank: [] };  // mlx model names are arbitrary — no version parsing
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

export { adapter as omlxAdapter };
```

Register in `src/model-providers/index.ts`:

```ts
import { omlxAdapter } from './omlx.js';
const BUILTIN_ADAPTERS: ModelProviderAdapter[] = [anthropicAdapter, openaiAdapter, omlxAdapter];
```

The default host is `localhost` rather than a public hostname — `model-discovery.ts` calls `http://${host}:${port}${modelsPath}`, and `OMLX_BASE_URL` overrides both. Port defaults to 8000 via the existing parser.

With the adapter in place:
- `/model` admin command on a `local`-provider agent lists discovered models from omlx.
- Models tab "Local" section shows all discovered models, with the curated Qwen3.6 entry rendered with full metadata and discovered-only entries rendered with bare-id cards (same pattern already used for cloud discovered models).

## 7. Out of scope

- **Direct chat mode** (cost-comparison "show me the bytes" panel). Separate spec.
- **Multi-active-model-per-agent.** Single-active + `/provider` switch is sufficient.
- **Additional local backends** (Ollama, LM Studio, separate omlx instances). The `'local'` slot is single-server-per-host for now. Future work: either generalize `'local'` to `'local-<name>'` or stand up parallel `local2` provider slots.
- **`/provider` admin command's local validation.** If the existing handler has a hard-coded allowlist excluding `'local'`, that's a one-line follow-up — not part of this spec.
- **Per-student local-model isolation.** Whole class shares one mlx-omni-server; concurrency is whatever the model can handle. The pedagogical point is *that* it's local, not perfect throughput.

## Files touched (summary, for the plan)

| File | Change |
|---|---|
| `src/container-config.ts` | Drop `openaiBackend`. `allowedModels` entries already typed. |
| `src/container-runner.ts` | Choose `/openai/v1` vs `/omlx/v1` based on `agent_provider`, not `openaiBackend`. |
| `src/credential-proxy.ts` | Add `/omlx/*` route. Read `OMLX_API_KEY`, `OMLX_BASE_URL`. |
| `container/agent-runner/src/providers/codex-app-server.ts` | `writeCodexMcpConfigToml(provider)` emits `[model_providers.openai]` or `[model_providers.omlx]` plus top-level `model` / `model_provider`. |
| `src/model-catalog.ts` | Add curated Qwen3.6 entry with `provider: 'local'`, `origin: 'local'`. |
| `src/model-providers/omlx.ts` | New adapter file. |
| `src/model-providers/index.ts` | Register `omlxAdapter`. |
| `src/model-discovery.ts` | No code change — `listAllForProvider('local')` works as soon as the adapter registers. |
| `src/channels/playground/api/models.ts` | Include `local` in the discovery fan-out. |
| `src/channels/playground/public/tabs/models.js` | Three-section layout (Claude / Codex / Local), Local-server status pill. |
| `src/admin-handlers/provider.ts` | Accept `'local'` if not already. |
| `.env` | New keys: `OMLX_API_KEY=godfrey`, `OMLX_BASE_URL=http://localhost:8000`. |

No new dependencies. No migration. No DB schema change.
