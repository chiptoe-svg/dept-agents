import fs from 'fs';

import { MODEL_CATALOG_LOCAL_PATH } from './config.js';
import { readCachedCodexModels, refreshCodexCatalog } from './model-catalog-refresh.js';

export interface ModelEntry {
  /** Stable id, used in container.json allowedModels and chat-tab dropdowns. */
  id: string;
  provider: 'claude' | 'codex' | 'opencode' | 'ollama' | string;
  displayName: string;
  /** "cloud" | "local" — drives card styling and whether host/context/etc. show. */
  origin: 'cloud' | 'local';

  /**
   * Cost per 1k tokens (USD) — 0 for local. Legacy single-rate field;
   * still consulted by older surfaces when split rates aren't available.
   * For accurate cost: use the In/Out/Cached fields below.
   */
  costPer1kTokensUsd?: number;
  /** Cost per 1k input tokens (USD). */
  costPer1kInUsd?: number;
  /** Cost per 1k output tokens (USD). Typically 4-5× input for cloud models. */
  costPer1kOutUsd?: number;
  /**
   * Cost per 1k cached-input tokens (USD). Anthropic prompt caching is
   * billed at ~10% of input rate; OpenAI prompt caching at ~50%. Absent
   * for providers without prompt caching.
   */
  costPer1kCachedInUsd?: number;
  /** Average latency in seconds — best-effort estimate. */
  avgLatencySec?: number;
  /** Parameter count display string ("70B", "8B", "?"). */
  paramCount?: string;
  /** Modalities the model accepts. */
  modalities?: ('text' | 'image' | 'audio')[];
  /** Free-form notes (instructor-authored on a class deployment for local entries). */
  notes?: string;

  /** Local-only: where the OpenAI-compatible endpoint lives. */
  host?: string;
  /** Local-only: context window size in tokens. */
  contextSize?: number;
  /** Local-only: quantization tag. */
  quantization?: string;

  /** Pedagogical chips ("⚡ fast", "$ cheap", "🐢 slower", "🆓 free", etc.). */
  chips?: string[];
  /** Suggested-use blurb. */
  bestFor?: string;
  /**
   * Marks this entry as the recommended default for its provider. Used by
   * the playground Models tab to visually distinguish "this is the entry
   * to pick if you have no preference" from "this is the entry the agent
   * is currently using." At most one per provider; if multiple are flagged
   * the UI picks the first.
   */
  default?: boolean;
}

const BUILTIN_ENTRIES: ModelEntry[] = [
  {
    id: 'claude-haiku-4-5',
    provider: 'claude',
    displayName: 'claude-haiku-4-5',
    origin: 'cloud',
    costPer1kInUsd: 0.001,
    costPer1kOutUsd: 0.005,
    costPer1kCachedInUsd: 0.0001,
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
    costPer1kInUsd: 0.003,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.0003,
    costPer1kTokensUsd: 0.012,
    avgLatencySec: 2.1,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['🐢 slower', '$$ pricier', '☁ Anthropic'],
    bestFor: 'Reasoning, long outputs.',
    default: true,
  },
  // Codex model entries — IDs + descriptions + pricing pulled verbatim
  // from OpenAI's docs:
  //   https://developers.openai.com/codex/models
  //   https://developers.openai.com/api/docs/pricing
  // Per-1M tokens → per-1k (divide by 1000). Update when OpenAI ships new
  // codex models or revises pricing — the auto-refresh task on the
  // post-class punch list will eventually keep this in sync automatically.
  {
    id: 'gpt-5.5',
    provider: 'codex',
    displayName: 'gpt-5.5',
    origin: 'cloud',
    costPer1kInUsd: 0.005,
    costPer1kOutUsd: 0.03,
    costPer1kCachedInUsd: 0.0005,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '🔝 frontier'],
    notes: "OpenAI's newest frontier codex model — complex coding, computer use, knowledge work, research.",
    bestFor: 'Hardest reasoning + multi-step coding tasks.',
    default: true,
  },
  {
    id: 'gpt-5.4',
    provider: 'codex',
    displayName: 'gpt-5.4',
    origin: 'cloud',
    costPer1kInUsd: 0.0025,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.00025,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '$$ pricier'],
    notes: 'Flagship — GPT-5.3-Codex coding capabilities + stronger reasoning, tool use, agentic workflows.',
    bestFor: 'Professional work blending coding with broader agentic flows.',
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'codex',
    displayName: 'gpt-5.4-mini',
    origin: 'cloud',
    costPer1kInUsd: 0.00075,
    costPer1kOutUsd: 0.0045,
    costPer1kCachedInUsd: 0.000075,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '⚡ fast', '$ cheap'],
    notes: 'Fast, efficient mini model for responsive coding tasks and subagents.',
    bestFor: 'Short tasks, classification, subagents — when latency matters more than depth.',
  },
  {
    id: 'gpt-5.3-codex',
    provider: 'codex',
    displayName: 'gpt-5.3-codex',
    origin: 'cloud',
    costPer1kInUsd: 0.00175,
    costPer1kOutUsd: 0.014,
    costPer1kCachedInUsd: 0.000175,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '💻 code'],
    notes: 'Industry-leading coding model — its coding capabilities also power GPT-5.4.',
    bestFor: 'Complex software engineering when you want the pure code-tuned model.',
  },
  {
    id: 'gpt-5.2',
    provider: 'codex',
    displayName: 'gpt-5.2',
    origin: 'cloud',
    // Pricing not on current pricing page (older general-purpose model);
    // omit rather than guess. The aggregator falls back to $0 cost which
    // is wrong but conservative — surface a warning if you start charging
    // students for 5.2 usage.
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '⏮ previous gen'],
    notes: 'Previous general-purpose codex model — hard debugging tasks needing deeper deliberation.',
    bestFor: 'Long-thinking debugging when newer models feel rushed.',
  },
  {
    id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
    provider: 'local',
    displayName: 'Qwen 3.6 (35B, MLX 4-bit)',
    origin: 'local',
    costPer1kTokensUsd: 0,
    avgLatencySec: 8,
    paramCount: '35B',
    modalities: ['text', 'image'],
    notes: 'Runs on the host Mac. Free, no quota — but slower than cloud.',
    host: 'http://localhost:8000',
    contextSize: 32768,
    quantization: 'MLX 4-bit',
    chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
    bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
    default: true,
  },
];

function readLocalEntries(): ModelEntry[] {
  if (!fs.existsSync(MODEL_CATALOG_LOCAL_PATH)) return [];
  try {
    const raw = fs.readFileSync(MODEL_CATALOG_LOCAL_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: ModelEntry) => ({ ...e, origin: 'local' as const }));
  } catch {
    return [];
  }
}

export function getModelCatalog(): ModelEntry[] {
  // Local-file entries win over built-ins with the same provider+id, so
  // an operator's local-catalog-local.json acts as an override layer
  // (used by the Models tab's edit / set-default flows).
  const localEntries = readLocalEntries();
  const localIds = new Set(localEntries.map((e) => `${e.provider}:${e.id}`));

  // Refresh layer: drop-on-disappear for codex models that have aged out of
  // OpenAI's docs page, plus surface newly-listed IDs as minimal entries
  // (no pricing — they're still hand-curated by editing BUILTIN_ENTRIES or
  // the Models-tab local override flow when prices need to attach).
  // Fires the background fetch as a side effect on every catalog read so
  // the cache stays warm without a dedicated scheduler. The refresh module
  // self-rate-limits via its 24h cache + in-flight guard, so this is cheap.
  refreshCodexCatalog().catch(() => {});
  const refreshed = readCachedCodexModels();
  let builtins = BUILTIN_ENTRIES;
  if (refreshed && refreshed.length > 0) {
    const allowedCodex = new Set(refreshed);
    builtins = builtins.filter((e) => e.provider !== 'codex' || allowedCodex.has(e.id));
    for (const id of refreshed) {
      const inBuiltins = builtins.some((e) => e.provider === 'codex' && e.id === id);
      const inLocal = localIds.has(`codex:${id}`);
      if (!inBuiltins && !inLocal) {
        builtins.push({
          id,
          provider: 'codex',
          displayName: id,
          origin: 'cloud',
          modalities: ['text'],
          notes: `Auto-discovered from developers.openai.com/codex/models on ${new Date().toISOString().slice(0, 10)}. Pricing not yet curated — edit src/model-catalog.ts BUILTIN_ENTRIES or use the Models tab to set rates.`,
        });
      }
    }
  }

  builtins = builtins.filter((e) => !localIds.has(`${e.provider}:${e.id}`));
  return [...builtins, ...localEntries];
}
