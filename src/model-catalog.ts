import fs from 'fs';

import { MODEL_CATALOG_LOCAL_PATH } from './config.js';
import { readCachedCodexModels, refreshCodexCatalog } from './model-catalog-refresh.js';
import { listProviderSpecs } from './providers/auth-registry.js';

// Side-effect imports so registrations happen before any catalog read.
import './providers/claude-spec.js';
import './providers/codex-spec.js';
import './providers/openai-platform-spec.js';
import './providers/omlx-spec.js';
import './providers/clemson-spec.js';
// Future provider modules add their own import line here.

export interface ModelEntry {
  /** Stable id, used in container.json allowedModels and chat-tab dropdowns. */
  id: string;
  modelProvider: 'anthropic' | 'openai-codex' | 'local' | 'opencode' | 'ollama' | string;
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
   * Cost per 1k cached-input tokens (USD). Both Anthropic and OpenAI
   * prompt caching bill at ~10% of the input rate. Absent for providers
   * without prompt caching.
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

/** Returns the assembled built-in catalog: concat of every registered
 *  ProviderAuthSpec's catalogModels. Order: registration order. */
export function getBuiltinEntries(): ModelEntry[] {
  return listProviderSpecs().flatMap((s) => s.catalogModels ?? []);
}

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
  const localIds = new Set(localEntries.map((e) => `${e.modelProvider}:${e.id}`));

  // Refresh layer: drop-on-disappear for codex models that have aged out of
  // OpenAI's docs page, plus surface newly-listed IDs as minimal entries
  // (no pricing — they're still hand-curated by editing codex-spec.ts catalogModels
  // or the Models-tab local override flow when prices need to attach).
  // Fires the background fetch as a side effect on every catalog read so
  // the cache stays warm without a dedicated scheduler. The refresh module
  // self-rate-limits via its 24h cache + in-flight guard, so this is cheap.
  refreshCodexCatalog().catch(() => {});
  const refreshed = readCachedCodexModels();
  let builtins = getBuiltinEntries();
  if (refreshed && refreshed.length > 0) {
    const allowedCodex = new Set(refreshed);
    builtins = builtins.filter((e) => e.modelProvider !== 'openai-codex' || allowedCodex.has(e.id));
    for (const id of refreshed) {
      const inBuiltins = builtins.some((e) => e.modelProvider === 'openai-codex' && e.id === id);
      const inLocal = localIds.has(`openai-codex:${id}`);
      if (!inBuiltins && !inLocal) {
        builtins.push({
          id,
          modelProvider: 'openai-codex',
          displayName: id,
          origin: 'cloud',
          modalities: ['text'],
          notes: `Auto-discovered from developers.openai.com/codex/models on ${new Date().toISOString().slice(0, 10)}. Pricing not yet curated — edit codex-spec.ts catalogModels or use the Models tab to set rates.`,
        });
      }
    }
  }

  builtins = builtins.filter((e) => !localIds.has(`${e.modelProvider}:${e.id}`));
  return [...builtins, ...localEntries];
}
