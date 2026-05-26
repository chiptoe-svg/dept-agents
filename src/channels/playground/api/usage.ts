/**
 * Per-agent usage aggregator. Reads every session's outbound.db for the
 * agent, sums tokens by model, multiplies by the catalog's per-model
 * pricing, and returns { thisMonth, total } buckets.
 *
 * Cost calculation: prefers split rates (costPer1kInUsd / Out / CachedIn).
 * Cache-read token counts are stored in the content JSON blob (key "cacheRead")
 * because messages_out has no dedicated column for them. Provider semantics differ:
 * - Anthropic: tokens_in = non-cached only; cacheRead is additive.
 * - OpenAI/Codex: tokens_in = total including cached; cacheRead must be subtracted
 *   from tokens_in before applying the full input rate, then charged separately at
 *   the cached rate (0.10× for OpenAI prefix-cache, matching costPer1kCachedInUsd in the catalog).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { getAgentGroup, getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { lookupRosterByUserId } from '../../../db/classroom-roster.js';
import { getDb } from '../../../db/connection.js';
import { readClassConfig } from '../../../class-config.js';
import { getActiveSessions } from '../../../db/sessions.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { sessionsBaseDir } from '../../../session-manager.js';
import type { ApiResult } from './me.js';

export interface UsageBucket {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  /** Per-model breakdown for the bucket. */
  byModel: { model: string; provider: string | null; tokensIn: number; tokensOut: number; costUsd: number }[];
}

export interface UsageResponse {
  agentGroup: { id: string; folder: string; name: string };
  thisMonth: UsageBucket;
  total: UsageBucket;
}

function priceFor(entry: ModelEntry | undefined, tokensIn: number, tokensOut: number, tokensCached: number): number {
  if (!entry) return 0;
  if (entry.costPer1kInUsd != null || entry.costPer1kOutUsd != null) {
    const inUsd = (tokensIn / 1000) * (entry.costPer1kInUsd ?? 0);
    const outUsd = (tokensOut / 1000) * (entry.costPer1kOutUsd ?? 0);
    const cachedUsd = (tokensCached / 1000) * (entry.costPer1kCachedInUsd ?? 0);
    return inUsd + outUsd + cachedUsd;
  }
  // Legacy single-rate field: apply blended to (in + out). Cached not modeled.
  const blend = entry.costPer1kTokensUsd ?? 0;
  return ((tokensIn + tokensOut) / 1000) * blend;
}

/** All session ids on disk for the given agent_group_id. Includes ones the
 *  sessions table no longer references (handy for total-lifetime usage). */
function sessionIdsForAgent(agentGroupId: string): string[] {
  const dir = path.join(sessionsBaseDir(), agentGroupId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function aggregateAgentUsage(agentGroupId: string): { thisMonth: UsageBucket; total: UsageBucket } {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const catalog = getModelCatalog();
  const catalogByKey = new Map(catalog.map((e) => [`${e.modelProvider}:${e.id}`, e]));

  // Aggregation buckets keyed by `provider:model` so we can look up pricing.
  const thisMonth = new Map<string, { tokensIn: number; tokensOut: number; tokensCached: number }>();
  const total = new Map<string, { tokensIn: number; tokensOut: number; tokensCached: number }>();

  for (const sessionId of sessionIdsForAgent(agentGroupId)) {
    const outboundPath = path.join(sessionsBaseDir(), agentGroupId, sessionId, 'outbound.db');
    if (!fs.existsSync(outboundPath)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(outboundPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          `SELECT timestamp, tokens_in, tokens_out, provider, model, content
           FROM messages_out
           WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL`,
        )
        .all() as {
        timestamp: string;
        tokens_in: number | null;
        tokens_out: number | null;
        provider: string | null;
        model: string | null;
        content: string | null;
      }[];
      // Translate legacy provider names stored in historical messages_out rows
      // to the new catalog names used by catalogByKey ('anthropic', 'openai-codex').
      const LEGACY_PROVIDER_REMAP: Record<string, string> = {
        claude: 'anthropic',
        codex: 'openai-codex',
      };

      for (const row of rows) {
        const provider = LEGACY_PROVIDER_REMAP[row.provider ?? ''] ?? row.provider ?? '?';
        const key = `${provider}:${row.model ?? '?'}`;
        const ti = row.tokens_in ?? 0;
        const to = row.tokens_out ?? 0;
        // Parse cacheRead from the content JSON blob (no dedicated DB column).
        let rawCacheRead = 0;
        if (row.content) {
          try {
            rawCacheRead = (JSON.parse(row.content) as { cacheRead?: number }).cacheRead ?? 0;
          } catch {
            /* malformed content — treat as 0 */
          }
        }
        // codex/openai: tokens_in = total including cached → deduct to get non-cached.
        // claude: tokens_in = non-cached only → cacheRead is additive.
        const isOpenAi =
          row.provider === 'codex' ||
          row.provider === 'openai-codex' ||
          row.provider === 'openai' ||
          row.provider === 'openai-custom';
        const tiNonCached = isOpenAi ? ti - rawCacheRead : ti;
        const tc = rawCacheRead;
        if (!total.has(key)) total.set(key, { tokensIn: 0, tokensOut: 0, tokensCached: 0 });
        const t = total.get(key)!;
        t.tokensIn += tiNonCached;
        t.tokensOut += to;
        t.tokensCached += tc;
        if (row.timestamp >= monthStart) {
          if (!thisMonth.has(key)) thisMonth.set(key, { tokensIn: 0, tokensOut: 0, tokensCached: 0 });
          const m = thisMonth.get(key)!;
          m.tokensIn += tiNonCached;
          m.tokensOut += to;
          m.tokensCached += tc;
        }
      }
    } catch {
      /* unreadable/legacy DB — skip */
    } finally {
      if (db) db.close();
    }
  }

  function build(buckets: Map<string, { tokensIn: number; tokensOut: number; tokensCached: number }>): UsageBucket {
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensCached = 0;
    let costUsd = 0;
    const byModel: UsageBucket['byModel'] = [];
    for (const [key, v] of buckets) {
      const [provider, model] = key.split(':');
      const entry = catalogByKey.get(`${provider}:${model}`);
      const c = priceFor(entry, v.tokensIn, v.tokensOut, v.tokensCached);
      tokensIn += v.tokensIn;
      tokensOut += v.tokensOut;
      tokensCached += v.tokensCached;
      costUsd += c;
      byModel.push({ model, provider, tokensIn: v.tokensIn, tokensOut: v.tokensOut, costUsd: c });
    }
    byModel.sort((a, b) => b.costUsd - a.costUsd);
    return { tokensIn, tokensOut, tokensCached, costUsd, byModel };
  }

  return { thisMonth: build(thisMonth), total: build(total) };
}

export function handleGetUsage(folder: string, providers?: string[]): ApiResult<UsageResponse> {
  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, body: { error: `no agent group for folder ${folder}` } };
  const { thisMonth, total } = aggregateAgentUsage(group.id);
  if (providers && providers.length > 0) {
    const allow = new Set(providers);
    for (const bucket of [thisMonth, total]) {
      bucket.byModel = bucket.byModel.filter((m) => m.provider !== null && allow.has(m.provider));
      bucket.tokensIn = bucket.byModel.reduce((s, m) => s + m.tokensIn, 0);
      bucket.tokensOut = bucket.byModel.reduce((s, m) => s + m.tokensOut, 0);
      bucket.costUsd = bucket.byModel.reduce((s, m) => s + m.costUsd, 0);
    }
  }
  return {
    status: 200,
    body: {
      agentGroup: { id: group.id, folder: group.folder, name: group.name },
      thisMonth,
      total,
    },
  };
}

/**
 * For the instructor roster: aggregate usage for every agent_group whose
 * folder starts with `student_`. Reuses aggregateAgentUsage per agent so
 * the cost-computation rules stay in one place.
 */
export function handleGetStudentsUsage(
  providers?: string[],
): ApiResult<{ students: (UsageResponse & { agentGroupId: string; enrolled: boolean; role: 'student' | 'ta' })[] }> {
  // Source of truth for "who's in the class" is class-config.json's
  // students[] + tas[] arrays. Walks both — instructor-side we don't
  // bother showing instructors (instructor knows who they are).
  // Enrolled status comes from classroom_roster.enrolled_at (set on first
  // sign-in via /login/enroll) OR from non-zero historical usage (for
  // students who chatted via older flows before enrolled_at existed).
  const classCfg = readClassConfig();
  const rosterStudents: { name: string; folder: string; role: 'student' | 'ta' }[] = [
    ...(classCfg?.students ?? []).map((s) => ({ ...s, role: 'student' as const })),
    ...(classCfg?.tas ?? []).map((s) => ({ ...s, role: 'ta' as const })),
  ];

  const allow = providers && providers.length > 0 ? new Set(providers) : null;
  function filterBucket(b: UsageBucket): UsageBucket {
    if (!allow) return b;
    const byModel = b.byModel.filter((m) => m.provider !== null && allow.has(m.provider));
    return {
      byModel,
      tokensIn: byModel.reduce((s, m) => s + m.tokensIn, 0),
      tokensOut: byModel.reduce((s, m) => s + m.tokensOut, 0),
      tokensCached: 0,
      costUsd: byModel.reduce((s, m) => s + m.costUsd, 0),
    };
  }

  const emptyBucket = (): UsageBucket => ({
    byModel: [],
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: 0,
  });

  const students: (UsageResponse & { agentGroupId: string; enrolled: boolean; role: 'student' | 'ta' })[] = [];
  for (const cfgStudent of rosterStudents) {
    const group = getAgentGroupByFolder(cfgStudent.folder);
    const rosterRow = lookupRosterByUserId(`class:${cfgStudent.folder}`);
    const enrolled = rosterRow ? rosterRow.enrolled_at != null : false;
    if (!group) {
      // Roster entry without a provisioned agent group — should be rare,
      // means class-skeleton didn't finish provisioning this student.
      // Render with zero-usage so the instructor sees the missing row.
      students.push({
        agentGroupId: '',
        agentGroup: { id: '', folder: cfgStudent.folder, name: cfgStudent.name || cfgStudent.folder },
        thisMonth: emptyBucket(),
        total: emptyBucket(),
        enrolled,
        role: cfgStudent.role,
      });
      continue;
    }
    const usage = aggregateAgentUsage(group.id);
    students.push({
      agentGroupId: group.id,
      // Prefer class-config.json's name (the real one) over agent_groups.name
      // in case the DB row is stale (older provisioning runs set name=folder).
      agentGroup: { id: group.id, folder: group.folder, name: cfgStudent.name || group.name },
      thisMonth: filterBucket(usage.thisMonth),
      total: filterBucket(usage.total),
      enrolled,
      role: cfgStudent.role,
    });
  }
  students.sort((a, b) => a.agentGroup.folder.localeCompare(b.agentGroup.folder));
  return { status: 200, body: { students } };
}

export async function handleGetStudentDetail(folder: string): Promise<
  ApiResult<{
    email: string | null;
    enrolledAt: string | null;
    persona: string | null;
    skills: string[];
    telegram: boolean;
    google: boolean;
    providers: Record<string, { hasApiKey: boolean; hasOAuth: boolean; active: string | null }>;
  }>
> {
  const group = getAgentGroupByFolder(folder);
  if (!group) return { status: 404, body: { error: `no agent group for folder ${folder}` } };

  const userId = `class:${folder}`;
  const rosterRow = lookupRosterByUserId(userId);

  // Persona: CLAUDE.local.md from the group folder
  let persona: string | null = null;
  const personaPath = path.join(process.cwd(), 'groups', folder, 'CLAUDE.local.md');
  if (fs.existsSync(personaPath)) {
    try {
      const raw = fs.readFileSync(personaPath, 'utf8').trim();
      persona = raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
    } catch {
      /* ignore */
    }
  }

  // Skills: subdirectories of groups/<folder>/skills/
  const skillsPath = path.join(process.cwd(), 'groups', folder, 'skills');
  let skills: string[] = [];
  if (fs.existsSync(skillsPath)) {
    try {
      skills = fs
        .readdirSync(skillsPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      /* ignore */
    }
  }

  // Telegram: check user_dms for this userId
  const db = getDb();
  const telegramRow = db
    .prepare(`SELECT 1 FROM user_dms WHERE user_id = ? AND channel_type = 'telegram' LIMIT 1`)
    .get(userId);
  const telegram = telegramRow != null;

  // Google: check optional module
  let google = false;
  try {
    const { hasStudentCredentials } = await import('../../../student-google-auth.js');
    google = hasStudentCredentials(userId);
  } catch {
    /* module not installed */
  }

  // Providers: check optional module
  const providers: Record<string, { hasApiKey: boolean; hasOAuth: boolean; active: string | null }> = {};
  try {
    const { loadStudentProviderCreds } = await import('../../../student-provider-auth.js');
    for (const pid of ['claude', 'codex']) {
      const creds = loadStudentProviderCreds(userId, pid);
      providers[pid] = {
        hasApiKey: (creds as { apiKey?: unknown } | null)?.apiKey != null,
        hasOAuth: (creds as { oauth?: unknown } | null)?.oauth != null,
        active: (creds as { active?: string } | null)?.active ?? null,
      };
    }
  } catch {
    /* module not installed */
  }

  return {
    status: 200,
    body: {
      email: rosterRow?.email ?? null,
      enrolledAt: rosterRow?.enrolled_at ?? null,
      persona,
      skills,
      telegram,
      google,
      providers,
    },
  };
}
