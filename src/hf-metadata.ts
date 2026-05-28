/**
 * Shared HuggingFace metadata fetcher. Used by the live-discovery paths
 * (OMLX, Clemson) to enrich newly-found model ids with structured fields
 * (paramCount, modalities, contextSize). Falls back to null when HF
 * doesn't recognise any candidate variant of the id.
 *
 * In-process 24h cache keyed by the input id (not the resolved repo) so
 * the same upstream call doesn't re-hit HF every refresh. Cache survives
 * for the host process lifetime; restart clears.
 *
 * Originally lifted from `src/channels/playground/api/models.ts`'s
 * autoFillFromHuggingFace (which still drives the per-card "Auto-fill"
 * button for the Models tab's metadata-editor modal). Kept independent
 * so neither caller has to import the other.
 */

import { log } from './log.js';

export interface HfMetadata {
  paramCount?: string;
  modalities?: ('text' | 'image' | 'audio')[];
  contextSize?: number;
  /** Free-form provenance line that callers can drop into ModelEntry.notes. */
  notes?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { value: HfMetadata | null; expiresAt: number }>();

function modalitiesFromPipelineTag(tag: string | undefined): ('text' | 'image' | 'audio')[] | undefined {
  if (!tag) return undefined;
  if (tag.includes('image-text-to-text') || tag.includes('visual-question-answering')) return ['text', 'image'];
  if (tag.includes('automatic-speech-recognition') || tag.includes('audio-to-text')) return ['text', 'audio'];
  if (tag === 'text-generation' || tag === 'conversational') return ['text'];
  return undefined;
}

/**
 * Generate a small ordered list of candidate HF repo identifiers for a
 * raw model id reported by an OpenAI-compatible upstream. The first
 * candidate that 200s wins. Order: most-specific (the raw id) → strip
 * common quantisation suffixes → try common-owner prefixes.
 */
function candidatesFor(id: string): string[] {
  const stripped = id
    .replace(/-MLX(-[0-9]+bit)?$/i, '')
    .replace(/-UD(-MLX(-[0-9]+bit)?)?$/i, '')
    .replace(/-fp8$|-fp16$/i, '')
    .replace(/-GGUF$/i, '');
  // Title-case the first character of the bare id for common-owner attempts —
  // HF repos are case-sensitive and many follow the model-family casing.
  const titled = stripped.length > 0 ? stripped[0]!.toUpperCase() + stripped.slice(1) : stripped;
  return Array.from(
    new Set([
      id,
      stripped,
      `mlx-community/${id}`,
      `Qwen/${titled}`,
      `Qwen/${stripped}`,
      `google/${titled}`,
      `meta-llama/${titled}`,
      `deepseek-ai/${titled}`,
      `mistralai/${titled}`,
      `openai/${stripped}`,
    ]),
  );
}

/**
 * Look up a model id on HuggingFace, returning enriched metadata or null
 * if no candidate variant resolves. Safe to call repeatedly — results
 * are cached per-id for 24 hours, including negative (null) responses
 * so we don't re-hit HF for ids it doesn't know.
 */
export async function fetchHfMetadata(id: string): Promise<HfMetadata | null> {
  const now = Date.now();
  const cached = cache.get(id);
  if (cached && cached.expiresAt > now) return cached.value;

  let metadata: HfMetadata | null = null;
  for (const cand of candidatesFor(id)) {
    metadata = await fetchOneRepo(cand);
    if (metadata) break;
  }
  // Direct lookups all 404'd — fall back to the search API. Strip
  // quantisation suffixes again so partial names still match upstream.
  if (!metadata) {
    const searchTerm = id
      .replace(/-MLX(-[0-9]+bit)?$/i, '')
      .replace(/-UD(-MLX(-[0-9]+bit)?)?$/i, '')
      .replace(/-fp8$|-fp16$/i, '')
      .replace(/-GGUF$/i, '');
    metadata = await searchHfModels(searchTerm, id);
  }
  if (metadata) {
    const matched = extractMatchedRepo(metadata);
    if (matched) metadata = await enrichWithConfigJson(metadata, matched);
  }
  cache.set(id, { value: metadata, expiresAt: now + CACHE_TTL_MS });
  return metadata;
}

async function fetchOneRepo(repo: string): Promise<HfMetadata | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(repo)}`, {
      signal: ctl.signal,
      headers: { 'user-agent': 'nanoclaw-playground/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      modelId?: string;
      pipeline_tag?: string;
      tags?: string[];
      config?: { max_position_embeddings?: number };
    };
    return synthesiseMetadata(data, repo);
  } catch (err) {
    log.debug('hf-metadata direct repo failed', { repo, err });
    return null;
  }
}

async function searchHfModels(query: string, originalId: string): Promise<HfMetadata | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=1&full=true`, {
      signal: ctl.signal,
      headers: { 'user-agent': 'nanoclaw-playground/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const hits = (await res.json()) as Array<{
      modelId?: string;
      pipeline_tag?: string;
      tags?: string[];
      config?: { max_position_embeddings?: number };
    }>;
    if (!Array.isArray(hits) || hits.length === 0) return null;
    return synthesiseMetadata(hits[0]!, hits[0]!.modelId || originalId);
  } catch (err) {
    log.debug('hf-metadata search failed', { query, err });
    return null;
  }
}

function synthesiseMetadata(
  data: {
    modelId?: string;
    pipeline_tag?: string;
    tags?: string[];
    config?: { max_position_embeddings?: number };
  },
  source: string,
): HfMetadata {
  const out: HfMetadata = {};
  const modalities = modalitiesFromPipelineTag(data.pipeline_tag);
  if (modalities) out.modalities = modalities;
  const paramTag = data.tags?.find((t) => /^\d+\.?\d*[BM]$/i.test(t));
  if (paramTag) out.paramCount = paramTag;
  if (typeof data.config?.max_position_embeddings === 'number') {
    out.contextSize = data.config.max_position_embeddings;
  }
  out.notes = `Auto-filled from HuggingFace (${data.modelId || source}).`;
  return out;
}

/**
 * Second-pass enrichment: the /api/models/<repo> response usually doesn't
 * include `max_position_embeddings`, so fetch the raw config.json from the
 * matched repo's main revision to fill in contextSize. Best-effort —
 * returns the original on any failure (timeout, missing file, parse).
 */
async function enrichWithConfigJson(meta: HfMetadata, repo: string): Promise<HfMetadata> {
  if (meta.contextSize != null) return meta;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`https://huggingface.co/${encodeURI(repo)}/resolve/main/config.json`, {
      signal: ctl.signal,
      headers: { 'user-agent': 'nanoclaw-playground/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return meta;
    const cfg = (await res.json()) as {
      max_position_embeddings?: number;
      // Multi-modal models (Gemma 4, Qwen-VL, …) nest the language config.
      text_config?: { max_position_embeddings?: number };
    };
    const ctx = cfg.max_position_embeddings ?? cfg.text_config?.max_position_embeddings;
    if (typeof ctx === 'number') {
      return { ...meta, contextSize: ctx };
    }
  } catch (err) {
    log.debug('hf-metadata config.json fetch failed', { repo, err });
  }
  return meta;
}

/** Pull the resolved repo id out of the synthesised notes line. */
function extractMatchedRepo(meta: HfMetadata): string | null {
  const m = meta.notes?.match(/Auto-filled from HuggingFace \(([^)]+)\)/);
  return m ? m[1]! : null;
}

/** Test seam. */
export function _resetHfCache(): void {
  cache.clear();
}
