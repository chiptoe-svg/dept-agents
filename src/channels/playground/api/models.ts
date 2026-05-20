import fs from 'fs';
import path from 'path';

import { MODEL_CATALOG_LOCAL_PATH } from '../../../config.js';
import { readContainerConfig, writeContainerConfig } from '../../../container-config.js';
import { readEnvFile } from '../../../env.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { listAllForProvider } from '../../../model-discovery.js';
import { setModel } from '../../../model-switch.js';
import { setProvider } from '../../../provider-switch.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface DiscoveredModel {
  provider: 'claude' | 'codex' | 'local';
  id: string;
}

export interface ModelsResponse {
  catalog: ModelEntry[];
  allowedModels: { provider: string; model: string }[];
  discovered: DiscoveredModel[];
  activeModel: { provider: string; model: string } | null;
  /**
   * Reachability of the local OpenAI-compatible server (mlx-omni-server etc.).
   * Probed server-side because the browser-side fetch sees a *different*
   * "localhost" when accessing the playground over the LAN. `null` when the
   * probe itself failed for a reason unrelated to reachability (timeout etc.).
   */
  localServerOnline: boolean | null;
}

async function probeLocalServer(): Promise<boolean> {
  const env = readEnvFile(['OMLX_BASE_URL']);
  const baseUrl = (process.env.OMLX_BASE_URL ?? env.OMLX_BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleGetModels(draftFolder: string): Promise<ApiResult<ModelsResponse>> {
  try {
    const cfg = readContainerConfig(draftFolder);
    const catalog = getModelCatalog();
    const catalogIds = new Set(catalog.map((m) => `${m.provider}:${m.id}`));

    const [claudeHints, codexHints, localHints, localServerOnline] = await Promise.all([
      listAllForProvider('claude').catch(() => []),
      listAllForProvider('codex').catch(() => []),
      listAllForProvider('local').catch(() => []),
      probeLocalServer(),
    ]);

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

    const activeModel = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;

    return {
      status: 200,
      body: {
        catalog,
        allowedModels: cfg.allowedModels ?? [],
        discovered,
        activeModel,
        localServerOnline,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutModels(
  draftFolder: string,
  body: { allowedModels?: unknown },
): ApiResult<{ ok: true; allowedModels: { provider: string; model: string }[] }> {
  if (!Array.isArray(body.allowedModels)) {
    return { status: 400, body: { error: 'allowedModels must be an array' } };
  }
  for (const e of body.allowedModels) {
    const entry = e as Record<string, unknown>;
    if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') {
      return { status: 400, body: { error: 'each entry needs string provider + model' } };
    }
  }
  const allowedModels = body.allowedModels as { provider: string; model: string }[];
  try {
    const cfg = readContainerConfig(draftFolder);
    cfg.allowedModels = allowedModels;
    writeContainerConfig(draftFolder, cfg);
    return { status: 200, body: { ok: true, allowedModels } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

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
    // Read current provider — if it's changing, route through setProvider
    // so sessions + agent_groups + running containers stay in sync. If
    // only the model is changing, just update container.json.
    const cfg = readContainerConfig(draftFolder);
    const currentProvider = cfg.provider ?? 'claude';
    if (currentProvider !== provider) {
      const result = setProvider(draftFolder, provider);
      if (!result.ok && result.reason !== 'no-change') {
        return { status: 500, body: { error: `provider switch failed: ${result.reason}` } };
      }
    }
    // Persist model to the DB — agent_groups.model is the source of truth that
    // ensureRuntimeFields syncs into container.json on every spawn. Writing
    // only to container.json (as this handler used to) gets silently clobbered
    // on the next container start when the DB-driven sync runs.
    if (!setModel(draftFolder, model)) {
      return { status: 500, body: { error: 'setModel failed (agent group not found by folder)' } };
    }
    // Re-read after potential setProvider write, then mirror the model into
    // container.json so the current on-disk state matches the DB without
    // waiting for the next spawn-time sync.
    const updated = readContainerConfig(draftFolder);
    updated.model = model;
    writeContainerConfig(draftFolder, updated);
    return { status: 200, body: { ok: true, activeModel: { provider, model } } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * Best-effort metadata lookup for a model id. Returns suggested catalog
 * fields that the frontend modal pre-populates; the user can still edit
 * before saving. Sources by provider:
 *   - local: HuggingFace search API. Tries the bare id then strips common
 *     quantization suffixes (-MLX-4bit, -UD-MLX-4bit, etc.) to find the
 *     upstream model card. Reads pipeline_tag for modalities, tags for
 *     license/architecture hints.
 *   - claude/codex: small hardcoded lookup table keyed by id substring.
 *     There's no public model-card API for cloud providers, so this is
 *     the realistic ceiling without scraping HTML docs. Users can extend
 *     CLOUD_METADATA below.
 */
const CLOUD_METADATA: Record<string, Partial<ModelEntry>> = {
  // Anthropic
  'claude-haiku-4-5': {
    displayName: 'claude-haiku-4-5',
    costPer1kTokensUsd: 0.0008,
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ Anthropic'],
    bestFor: 'Short answers, classification, structured output.',
  },
  'claude-sonnet-4-6': {
    displayName: 'claude-sonnet-4-6',
    costPer1kTokensUsd: 0.012,
    modalities: ['text', 'image'],
    chips: ['🐢 slower', '$$ pricier', '☁ Anthropic'],
    bestFor: 'Reasoning, long outputs.',
  },
  'claude-opus-4-7': {
    displayName: 'claude-opus-4-7',
    costPer1kTokensUsd: 0.03,
    modalities: ['text', 'image'],
    chips: ['🐢 slower', '$$$ premium', '☁ Anthropic'],
    bestFor: 'Frontier reasoning, hard problems.',
  },
  // OpenAI
  'gpt-5-mini': {
    displayName: 'gpt-5-mini',
    costPer1kTokensUsd: 0.0006,
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ OpenAI'],
    bestFor: 'Quick, broad-knowledge tasks.',
  },
  'gpt-5': {
    displayName: 'gpt-5',
    costPer1kTokensUsd: 0.005,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI'],
    bestFor: 'General-purpose, well-rounded.',
  },
  'gpt-5-codex': {
    displayName: 'gpt-5-codex',
    costPer1kTokensUsd: 0.004,
    modalities: ['text'],
    chips: ['💻 code', '☁ OpenAI'],
    bestFor: 'Code generation + analysis.',
  },
};

function modalitiesFromPipelineTag(tag: string | undefined): ('text' | 'image' | 'audio')[] | undefined {
  if (!tag) return undefined;
  if (tag.includes('image-text-to-text') || tag.includes('visual-question-answering')) return ['text', 'image'];
  if (tag.includes('automatic-speech-recognition') || tag.includes('audio-to-text')) return ['text', 'audio'];
  if (tag === 'text-generation' || tag === 'conversational') return ['text'];
  return undefined;
}

async function autoFillFromHuggingFace(id: string): Promise<Partial<ModelEntry> | null> {
  // mlx-omni-server ids are usually `<owner>/<quantized-variant>` or just
  // `<quantized-variant>`. The HF model card we want is the upstream
  // (non-quantized) repo. Try a few strategies in order, returning the
  // first hit.
  const stripped = id
    .replace(/-MLX(-[0-9]+bit)?$/i, '')
    .replace(/-UD(-MLX(-[0-9]+bit)?)?$/i, '')
    .replace(/-GGUF$/i, '');
  const candidates = Array.from(
    new Set([
      id,
      stripped,
      // common owner prefixes for MLX-quantized models on HF
      `mlx-community/${id}`,
      `Qwen/${stripped}`,
      `google/${stripped}`,
      `meta-llama/${stripped}`,
    ]),
  );

  for (const cand of candidates) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(cand)}`, {
        signal: ctl.signal,
        headers: { 'user-agent': 'nanoclaw-playground/1.0' },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = (await res.json()) as {
        id?: string;
        pipeline_tag?: string;
        tags?: string[];
        modelId?: string;
      };
      const modalities = modalitiesFromPipelineTag(data.pipeline_tag);
      const out: Partial<ModelEntry> = { displayName: id };
      if (modalities) out.modalities = modalities;
      // Param count is hard to pull from HF API reliably; many cards have
      // it as a tag like "params:27B" but most don't. Skip unless obvious.
      const paramTag = data.tags?.find((t) => /^\d+\.?\d*[BM]$/i.test(t));
      if (paramTag) out.paramCount = paramTag;
      // Notes: include the HF source so user knows where the fields came from.
      out.notes = `Auto-filled from HuggingFace (${data.modelId || cand}).`;
      return out;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function handleAutoFillCatalog(body: {
  provider?: unknown;
  id?: unknown;
}): Promise<ApiResult<{ suggestion: Partial<ModelEntry> | null; source: string }>> {
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const id = typeof body.id === 'string' ? body.id : '';
  if (!provider || !id) return { status: 400, body: { error: 'provider and id required' } };

  if (provider === 'local') {
    const suggestion = await autoFillFromHuggingFace(id);
    return { status: 200, body: { suggestion, source: 'huggingface' } };
  }

  if (provider === 'claude' || provider === 'codex') {
    // Exact match first, then substring (gpt-5-mini in id "gpt-5-mini-2025-01-15", etc.).
    const exact = CLOUD_METADATA[id];
    if (exact) return { status: 200, body: { suggestion: exact, source: 'builtin-table' } };
    const subKey = Object.keys(CLOUD_METADATA).find((k) => id.startsWith(k));
    if (subKey) return { status: 200, body: { suggestion: CLOUD_METADATA[subKey], source: 'builtin-table' } };
    return { status: 200, body: { suggestion: null, source: 'builtin-table' } };
  }

  return { status: 200, body: { suggestion: null, source: 'no-source-for-provider' } };
}

/**
 * Append (or replace) a curated catalog entry in config/model-catalog-local.json.
 * Lets the Models tab promote a discovered-only model into a richer card
 * without hand-editing JSON. Dedupes on `provider:id` — re-saving the same
 * model replaces the previous entry rather than duplicating.
 */
export function handlePutLocalCatalogEntry(body: { entry?: unknown }): ApiResult<{ ok: true; entry: ModelEntry }> {
  const entry = body.entry as Partial<ModelEntry> | undefined;
  if (!entry || typeof entry !== 'object') {
    return { status: 400, body: { error: 'entry object required' } };
  }
  if (typeof entry.id !== 'string' || !entry.id) return { status: 400, body: { error: 'entry.id required' } };
  if (typeof entry.provider !== 'string' || !entry.provider)
    return { status: 400, body: { error: 'entry.provider required' } };
  if (typeof entry.displayName !== 'string' || !entry.displayName)
    return { status: 400, body: { error: 'entry.displayName required' } };

  // Coerce origin from provider if absent: cloud for claude/codex, local for local.
  const origin: 'cloud' | 'local' =
    entry.origin === 'local' || entry.origin === 'cloud'
      ? entry.origin
      : entry.provider === 'local'
        ? 'local'
        : 'cloud';

  const clean: ModelEntry = {
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName,
    origin,
    ...(typeof entry.paramCount === 'string' ? { paramCount: entry.paramCount } : {}),
    ...(Array.isArray(entry.modalities) ? { modalities: entry.modalities as ('text' | 'image' | 'audio')[] } : {}),
    ...(typeof entry.contextSize === 'number' ? { contextSize: entry.contextSize } : {}),
    ...(typeof entry.quantization === 'string' ? { quantization: entry.quantization } : {}),
    ...(typeof entry.avgLatencySec === 'number' ? { avgLatencySec: entry.avgLatencySec } : {}),
    ...(typeof entry.costPer1kTokensUsd === 'number' ? { costPer1kTokensUsd: entry.costPer1kTokensUsd } : {}),
    ...(typeof entry.host === 'string' ? { host: entry.host } : {}),
    ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
    ...(typeof entry.bestFor === 'string' ? { bestFor: entry.bestFor } : {}),
    ...(Array.isArray(entry.chips) ? { chips: entry.chips as string[] } : {}),
  };

  try {
    let arr: ModelEntry[] = [];
    if (fs.existsSync(MODEL_CATALOG_LOCAL_PATH)) {
      const raw = fs.readFileSync(MODEL_CATALOG_LOCAL_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed as ModelEntry[];
    } else {
      fs.mkdirSync(path.dirname(MODEL_CATALOG_LOCAL_PATH), { recursive: true });
    }
    arr = arr.filter((e) => !(e.provider === clean.provider && e.id === clean.id));
    arr.push(clean);
    fs.writeFileSync(MODEL_CATALOG_LOCAL_PATH, JSON.stringify(arr, null, 2) + '\n');
    return { status: 200, body: { ok: true, entry: clean } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * Toggle the `default` flag for one catalog entry. Enforces the invariant
 * that at most one entry per provider is the default — setting model X
 * as default automatically un-sets any other default in the same provider.
 * Clicking the star on an entry that's already default un-sets it (no
 * replacement; the provider has no recommended default after that).
 *
 * Writes through to config/model-catalog-local.json. For built-in entries
 * being mutated, the full ModelEntry is copied into the local overrides
 * file (with the flipped default flag) so getModelCatalog's local-wins
 * dedup serves the right value on the next API call.
 */
export function handleToggleDefaultModel(body: {
  provider?: unknown;
  id?: unknown;
}): ApiResult<{ ok: true; provider: string; id: string; default: boolean }> {
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const id = typeof body.id === 'string' ? body.id : '';
  if (!provider || !id) return { status: 400, body: { error: 'provider and id required' } };

  const catalog = getModelCatalog();
  const target = catalog.find((e) => e.provider === provider && e.id === id);
  if (!target) return { status: 404, body: { error: `no catalog entry for ${provider}:${id}` } };
  const targetIsCurrentlyDefault = Boolean(target.default);

  // Other entries for this provider currently flagged default. Will be
  // unset when target gets set; left alone when target is being un-set.
  const otherDefaults = catalog.filter((e) => e.provider === provider && !(e.id === id) && e.default === true);

  try {
    let arr: ModelEntry[] = [];
    if (fs.existsSync(MODEL_CATALOG_LOCAL_PATH)) {
      const raw = fs.readFileSync(MODEL_CATALOG_LOCAL_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed as ModelEntry[];
    } else {
      fs.mkdirSync(path.dirname(MODEL_CATALOG_LOCAL_PATH), { recursive: true });
    }

    function upsert(entry: ModelEntry): void {
      arr = arr.filter((e) => !(e.provider === entry.provider && e.id === entry.id));
      arr.push(entry);
    }

    // Toggle target.
    upsert({ ...target, default: !targetIsCurrentlyDefault });

    // If we're enabling the target's default, also clear others.
    if (!targetIsCurrentlyDefault) {
      for (const other of otherDefaults) {
        upsert({ ...other, default: false });
      }
    }

    fs.writeFileSync(MODEL_CATALOG_LOCAL_PATH, JSON.stringify(arr, null, 2) + '\n');
    return { status: 200, body: { ok: true, provider, id, default: !targetIsCurrentlyDefault } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
