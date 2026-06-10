/**
 * Owner-gated API handlers for install-wide web-search backend selection.
 *
 * Two endpoints:
 *   GET  /api/web-search-config  — status: active provider + per-backend availability
 *   POST /api/web-search-config  — set the active provider; respawns agent containers
 */
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { readWebSearchProvider, writeWebSearchProvider, type WebSearchProvider } from '../../../web-search-config.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from './enrollment.js';

interface BackendStatus {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

function isOwnerOrAdmin(userId: string | null): boolean {
  if (!userId) return false;
  return isOwner(userId) || isGlobalAdmin(userId);
}

async function searxngReachable(): Promise<boolean> {
  const base = process.env.SEARXNG_URL;
  if (!base) return false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${base.replace(/\/+$/, '')}/search?q=ping&format=json`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// ── GET /api/web-search-config ────────────────────────────────────────────

export async function handleGetWebSearchConfig(
  session: PlaygroundSession,
): Promise<ApiResult<{ active: WebSearchProvider; backends: BackendStatus[] }>> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  const backends: BackendStatus[] = [
    {
      id: 'brave',
      label: 'Brave',
      available: !!process.env.WEB_SEARCH_API_KEY,
      note: process.env.WEB_SEARCH_API_KEY ? undefined : 'No Brave API key set (WEB_SEARCH_API_KEY).',
    },
    {
      id: 'searxng',
      label: 'SearXNG (self-hosted)',
      available: await searxngReachable(),
      note: process.env.SEARXNG_URL ? undefined : 'SEARXNG_URL not set.',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      available: false,
      note: 'Not yet available (requires OpenAI Responses-API integration).',
    },
  ];
  return { status: 200, body: { active: readWebSearchProvider(), backends } };
}

// ── POST /api/web-search-config ───────────────────────────────────────────

export function handlePostWebSearchConfig(
  session: PlaygroundSession,
  body: { provider?: unknown },
): ApiResult<{ ok: true; active: WebSearchProvider }> {
  if (!isOwnerOrAdmin(session.userId)) {
    return { status: 403, body: { error: 'owner role required' } };
  }
  const provider = body.provider;
  if (provider !== 'brave' && provider !== 'searxng') {
    return { status: 400, body: { error: 'provider must be an available backend (brave | searxng)' } };
  }
  if (provider === 'brave' && !process.env.WEB_SEARCH_API_KEY) {
    return { status: 400, body: { error: 'Brave is unavailable — no WEB_SEARCH_API_KEY set.' } };
  }
  if (provider === 'searxng' && !process.env.SEARXNG_URL) {
    return { status: 400, body: { error: 'SearXNG is unavailable — SEARXNG_URL not set.' } };
  }
  writeWebSearchProvider(provider, session.userId!);
  for (const g of getAllAgentGroups()) {
    if (g.folder === '_default_participant') continue;
    restartAgentGroupContainers(g.id, 'web-search-backend-change');
  }
  return { status: 200, body: { ok: true, active: provider } };
}
