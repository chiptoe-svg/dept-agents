import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

const OMLX_BASE_URL = process.env.OMLX_BASE_URL || 'http://localhost:8000';

async function probeReachability(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    // OMLX servers may require a bearer token even on /v1/models. Send the same
    // token the credential-proxy would substitute on real outbound requests so
    // the probe semantics match runtime: unreachable means the server is down
    // OR the key is wrong — both are user-actionable. Defaults to 'godfrey' per
    // resolveOmlxKey() (mptab-7).
    const token = process.env.OMLX_API_KEY ?? 'godfrey';
    const res = await fetch(`${OMLX_BASE_URL}/v1/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

registerProvider({
  id: 'omlx',
  displayName: 'OMLX (local server)',
  proxyRoutePrefix: '/omlx/',
  credentialFileShape: 'none',
  catalogModels: [
    {
      id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      modelProvider: 'local',
      displayName: 'Qwen 3.6 (35B, MLX 4-bit)',
      origin: 'local',
      costPer1kTokensUsd: 0,
      // mlx-omni-server returns prompt-cache reads in usage (verified via
      // smoke test 2026-05-26 — cdbc213 — `cacheRead: 20480`).
      // costPer1kCachedInUsd: 0 lets cost-tracking notice the bucket
      // consistently with other providers — zero dollars either way.
      costPer1kCachedInUsd: 0,
      avgLatencySec: 8,
      paramCount: '35B',
      modalities: ['text', 'image'],
      notes: 'Runs on the host Mac. Free, no quota — but slower than cloud.',
      host: OMLX_BASE_URL,
      contextSize: 32768,
      quantization: 'MLX 4-bit',
      chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
      bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
      default: true,
    },
  ] satisfies ModelEntry[],
  reachability: probeReachability,
});
