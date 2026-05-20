/**
 * Direct chat — calls the upstream LLM API directly via the credential
 * proxy, no agent infrastructure. The Chat tab's "Chat (no agent)" mode
 * uses this so students can see raw model behavior without agent
 * scaffolding (system prompts, skills, MCP tools, etc.).
 *
 * Today supports the OpenAI Chat Completions wire format. /openai/*
 * goes to api.openai.com; /omlx/* hits the local mlx-omni-server. Claude
 * support can be added by branching on provider and translating to the
 * Anthropic /v1/messages format — not wired today since the class is
 * OpenAI-only.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CREDENTIAL_PROXY_PORT } from '../../../config.js';
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { sessionsBaseDir } from '../../../session-manager.js';
import type { ApiResult } from './me.js';

export interface DirectChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DirectChatResponse {
  text: string;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  /**
   * Reasoning (a.k.a. thinking) tokens — billed as output tokens but
   * generated for the model's internal chain-of-thought rather than the
   * visible reply. Always ≤ tokensOut. Surfaced separately so cost
   * displays can attribute "where the money went" between visible output
   * and silent reasoning.
   */
  tokensReasoning: number;
  costUsd: number;
  model: string;
  /** Effort level used for the turn, if the request specified one. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

function priceFor(entry: ModelEntry | undefined, tokensIn: number, tokensOut: number, tokensCached: number): number {
  if (!entry) return 0;
  if (entry.costPer1kInUsd != null || entry.costPer1kOutUsd != null) {
    const billedIn = Math.max(0, tokensIn - tokensCached);
    return (
      (billedIn / 1000) * (entry.costPer1kInUsd ?? 0) +
      (tokensCached / 1000) * (entry.costPer1kCachedInUsd ?? 0) +
      (tokensOut / 1000) * (entry.costPer1kOutUsd ?? 0)
    );
  }
  const blend = entry.costPer1kTokensUsd ?? 0;
  return ((tokensIn + tokensOut) / 1000) * blend;
}

/**
 * Append a row to the agent's outbound.db so /api/usage/:folder counts
 * direct-chat traffic alongside agent-mediated traffic. We use a pseudo
 * "direct-chat" session directory per agent_group so the data doesn't
 * collide with real session DBs. Missing dir / write failure is logged
 * but non-fatal (the user still got their reply).
 */
function recordDirectChatUsage(
  agentGroupId: string,
  provider: string,
  model: string,
  text: string,
  tokensIn: number,
  tokensOut: number,
): void {
  const sessionDir = path.join(sessionsBaseDir(), agentGroupId, 'direct-chat');
  const outboundPath = path.join(sessionDir, 'outbound.db');
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const db = new Database(outboundPath);
    db.exec(`CREATE TABLE IF NOT EXISTS messages_out (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp TEXT NOT NULL,
      deliver_after TEXT,
      recurrence TEXT,
      kind TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      latency_ms INTEGER,
      provider TEXT,
      model TEXT
    )`);
    const id = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, content, tokens_in, tokens_out, provider, model)
       VALUES (?, datetime('now'), 'direct-chat', ?, ?, ?, ?, ?)`,
    ).run(id, JSON.stringify({ text }), tokensIn, tokensOut, provider, model);
    db.close();
  } catch (err) {
    console.error('[direct-chat] usage record failed:', err);
  }
}

/**
 * Wire-format dispatch — OpenAI Chat Completions path. Used for both
 * the `codex` provider (cloud OpenAI via /openai/v1) and the `local`
 * provider (mlx-omni-server via /omlx/v1). Throws with a `status` field
 * on upstream failure so the caller can pass it through.
 */
async function dispatchOpenAI(
  provider: 'codex' | 'local',
  model: string,
  messages: DirectChatMessage[],
  reasoningEffort: 'low' | 'medium' | 'high' | undefined,
): Promise<{ text: string; tokensIn: number; tokensOut: number; tokensCached: number; tokensReasoning: number }> {
  const proxyPrefix = provider === 'codex' ? '/openai/v1' : '/omlx/v1';
  const url = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}${proxyPrefix}/chat/completions`;
  const requestBody: Record<string, unknown> = { model, messages };
  if (reasoningEffort) requestBody.reasoning_effort = reasoningEffort;
  const upstream = await fetchOrThrow(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
    body: JSON.stringify(requestBody),
  });
  const data = (await upstream.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    tokensCached: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    // OpenAI bills reasoning tokens as part of completion_tokens; we surface
    // them separately so the UI can show "of these out tokens, N were
    // reasoning." Models without reasoning return 0 (or omit the field).
    tokensReasoning: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Wire-format dispatch — Anthropic Messages path. Used for the `claude`
 * provider. The credential proxy's default route (no /openai or /omlx
 * prefix) forwards to api.anthropic.com and injects the x-api-key
 * header, so we just POST /v1/messages.
 *
 * Translation differences from OpenAI Chat Completions:
 *   - `system` is a top-level field, NOT a role in messages[]. We pull
 *     system messages out and concatenate into the `system` string.
 *   - `max_tokens` is required (no default). We pass 4096 — high enough
 *     for most direct-chat replies, low enough to fit under most
 *     models' context windows even with long inputs.
 *   - Response text comes from content[].text (filtered to type='text';
 *     thinking blocks come back as type='thinking' but are off by default).
 *   - Usage fields are `input_tokens` / `output_tokens` /
 *     `cache_read_input_tokens` (the cached-input rate applies to reads;
 *     `cache_creation_input_tokens` bills at the higher write-rate but
 *     we surface them as plain input for simplicity — the catalog's
 *     `costPer1kCachedInUsd` only models reads).
 */
async function dispatchAnthropic(
  model: string,
  messages: DirectChatMessage[],
): Promise<{ text: string; tokensIn: number; tokensOut: number; tokensCached: number; tokensReasoning: number }> {
  const systemParts: string[] = [];
  const userAndAssistant: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else userAndAssistant.push({ role: m.role, content: m.content });
  }
  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: userAndAssistant,
  };
  if (systemParts.length > 0) requestBody.system = systemParts.join('\n\n');

  const url = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}/v1/messages`;
  const upstream = await fetchOrThrow(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The proxy strips/replaces x-api-key with the real one — but
      // requires the header to exist so it knows to substitute.
      'x-api-key': 'placeholder',
      // Anthropic API version pin — Claude API rejects requests without it.
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });
  const data = (await upstream.json()) as {
    content?: { type: string; text?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return {
    text,
    tokensIn: data.usage?.input_tokens ?? 0,
    tokensOut: data.usage?.output_tokens ?? 0,
    tokensCached: data.usage?.cache_read_input_tokens ?? 0,
    // Claude's API doesn't expose reasoning-token counts in the messages
    // response (extended-thinking output counts as output_tokens, not
    // separately). Surface 0; UI omits the "reasoning" breakdown when 0.
    tokensReasoning: 0,
  };
}

/**
 * fetch() wrapper that throws a structured error (carrying `status` so
 * the caller can pass it through to the API response) on upstream
 * failure. Keeps the per-provider dispatchers free of error-translation
 * boilerplate.
 */
async function fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw { status: 502, message: `proxy unreachable: ${(err as Error).message}` };
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw { status: resp.status, message: `upstream ${resp.status}: ${errText.slice(0, 400)}` };
  }
  return resp;
}

export async function handleDirectChat(body: {
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
  agentFolder?: unknown;
  reasoningEffort?: unknown;
}): Promise<ApiResult<DirectChatResponse>> {
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const model = typeof body.model === 'string' ? body.model : '';
  const messages = Array.isArray(body.messages) ? (body.messages as DirectChatMessage[]) : [];
  const agentFolder = typeof body.agentFolder === 'string' ? body.agentFolder : '';
  const reasoningEffort: 'low' | 'medium' | 'high' | undefined =
    body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high'
      ? body.reasoningEffort
      : undefined;
  if (!provider || !model) return { status: 400, body: { error: 'provider and model required' } };
  if (messages.length === 0) return { status: 400, body: { error: 'messages array required' } };

  // Three providers, two wire formats:
  //   codex / local → OpenAI Chat Completions (/openai/v1, /omlx/v1)
  //   claude        → Anthropic Messages       (/v1/messages, proxy default)
  // The two formats differ in request structure (system as top-level vs.
  // first message), token usage field names, and reasoning visibility,
  // so each gets its own dispatch + parse pair below.
  let dispatch: { text: string; tokensIn: number; tokensOut: number; tokensCached: number; tokensReasoning: number };
  try {
    if (provider === 'codex' || provider === 'local') {
      dispatch = await dispatchOpenAI(provider, model, messages, reasoningEffort);
    } else if (provider === 'claude') {
      dispatch = await dispatchAnthropic(model, messages);
    } else {
      return { status: 400, body: { error: `direct-chat doesn't support provider ${provider} yet` } };
    }
  } catch (err) {
    const e = err as { status?: number; message: string };
    return { status: e.status ?? 502, body: { error: e.message } };
  }
  const { text, tokensIn, tokensOut, tokensCached, tokensReasoning } = dispatch;

  const catalog = getModelCatalog();
  const entry = catalog.find((e) => e.provider === provider && e.id === model);
  const costUsd = priceFor(entry, tokensIn, tokensOut, tokensCached);

  // Best-effort: record into the agent's pseudo session-outbound so usage
  // aggregation picks it up. Failure is non-fatal.
  if (agentFolder) {
    const group = getAgentGroupByFolder(agentFolder);
    if (group) recordDirectChatUsage(group.id, provider, model, text, tokensIn, tokensOut);
  }

  return {
    status: 200,
    body: { text, tokensIn, tokensCached, tokensOut, tokensReasoning, costUsd, model, reasoningEffort },
  };
}
