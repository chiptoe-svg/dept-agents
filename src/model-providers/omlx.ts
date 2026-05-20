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

function parseId(id: string): ParsedModel | null {
  return { id, alias: id, rank: [] };
}

function pickTop(parsed: ParsedModel[], maxCount: number): ParsedModel[] {
  return [...parsed].sort((a, b) => a.alias.localeCompare(b.alias)).slice(0, maxCount);
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
