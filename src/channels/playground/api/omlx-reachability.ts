import { getProviderSpec } from '../../../providers/auth-registry.js';
import { reachabilityCache } from './models-tab-state.js';

export async function handleOmlxReachability(): Promise<{
  status: number;
  body: { ok: boolean; checkedAt: string };
}> {
  const spec = getProviderSpec('omlx');
  if (!spec?.reachability) {
    return { status: 404, body: { ok: false, checkedAt: new Date().toISOString() } };
  }
  // Bust the cache so the next /api/me/models-tab-state read returns the fresh state
  // (rather than serving the previous probe's value for up to 30 seconds).
  reachabilityCache.delete('omlx');
  const ok = await spec.reachability();
  return { status: 200, body: { ok, checkedAt: new Date().toISOString() } };
}
