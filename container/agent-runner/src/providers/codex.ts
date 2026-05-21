/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, Codex-owned context
 * management, and stable MCP config via ~/.codex/config.toml — which is the
 * same mechanism the standalone codex CLI uses, so the container and host
 * share one provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexConfigToml,
} from './codex-app-server.js';

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't expand Claude Code's `@-import` syntax in
// CLAUDE.md, and doesn't auto-load CLAUDE.local.md from the working dir the
// way Claude Code does. Left alone, the agent sees only the raw import
// directives as literal text and none of the composed content — no shared
// CLAUDE.md, no module fragments, no per-group memory. We resolve both here
// so Codex (and any other non-Claude provider) gets the same effective
// system prompt the Claude provider gets natively.

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`. Recurses so imports
 * within imported files expand too. Cycles and missing files are silently
 * dropped (replaced with empty text) rather than left as raw `@path` lines,
 * which would confuse the model.
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  // Per-group CLAUDE.md is responsible for pulling in the global instructions
  // if the group wants them (the default scaffold starts with
  // `@./.claude-global.md` which resolveClaudeImports inlines). Appending
  // `/workspace/global/CLAUDE.md` explicitly here would double-inline the
  // global content for any non-main group, wasting context tokens and
  // risking contradictory instructions. Groups that don't import global
  // intentionally don't get it — same as Claude-backed agents.
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/**
 * Build a discovery list of skills available to this group. Mirrors what
 * Claude Code surfaces natively via its `Skill` tool — name + one-line
 * description per skill, scoped to the per-group symlinks at
 * `/home/node/.claude/skills/` (which respects `container.json`'s skill
 * selection, so groups that opted out won't see disabled skills here).
 *
 * The result is a single markdown section the model treats as part of its
 * system prompt. We deliberately don't inline each SKILL.md's full body —
 * that's tens of KB across the catalog and most won't apply to any given
 * turn. Instead we tell the model: "When a description matches, Read the
 * full SKILL.md before acting." That mirrors Claude Code's discoverable-
 * skill model and keeps prompt overhead proportional to skill count.
 */
export function composeAvailableSkills(
  skillsDir = '/home/node/.claude/skills',
  allowedNames?: string[] | 'all',
): string | undefined {
  if (!fs.existsSync(skillsDir)) return undefined;

  // null means "all enabled" (legacy default before per-agent filtering
  // existed); an array narrows the visible set. Empty array → nothing
  // visible, which is a valid user choice (run agent with no skills).
  const allow = allowedNames === undefined || allowedNames === 'all' ? null : new Set(allowedNames);

  const entries: { name: string; description: string }[] = [];
  for (const dirent of fs.readdirSync(skillsDir).sort()) {
    if (allow && !allow.has(dirent)) continue;
    const skillMdPath = path.join(skillsDir, dirent, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    const fm = parseFrontmatter(raw);
    const name = fm.name ?? dirent;
    const description = fm.description?.trim();
    if (!description) continue;
    entries.push({ name, description });
  }
  if (entries.length === 0) return undefined;

  const list = entries.map((e) => `- **${e.name}** — ${e.description}`).join('\n');
  return [
    '# Available skills',
    '',
    "When the user's request matches a skill below, your first action is to `Read /app/skills/<name>/SKILL.md` and follow the recipe inside before doing the work. The skill's instructions take precedence over your defaults for the task it covers.",
    '',
    list,
  ].join('\n');
}

/**
 * Minimal YAML frontmatter parser — extracts `key: value` pairs from an
 * opening `---`/`---` block. Good enough for the SKILL.md schema (flat
 * scalar fields). Doesn't handle nested objects or multiline strings; if
 * a skill grows those, expand here.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Build the one-line runtime identity block prepended to base_instructions.
 *
 * Codex's app-server only puts the model name into the *routing* layer (the
 * `model` field on each API request to the upstream and in turn_context's
 * collaboration_mode). It does NOT surface that name into the LLM-visible
 * system prompt. The cloud-OpenAI path doesn't need this — OpenAI models
 * recognize their own identity from training — but local models like
 * Qwen3.6 confabulate ("I'm a GPT-5 model") because the only model names
 * they see in their prompt are the codex default skill descriptions
 * (openai-docs, etc.).
 *
 * The value below is the same string that drives config.toml's `model =`
 * line and the upstream API request body, so the identity is accurate by
 * construction — there's no separate source of truth to drift from.
 */
export function composeRuntimeIdentity(provider: string, model: string | undefined): string | undefined {
  if (!model) return undefined;
  return `Runtime context: you are running on model "${model}" via the "${provider}" provider. If asked which model you are, answer with the model identifier above — do not guess.`;
}

function composeBaseInstructions(
  promptAddendum: string | undefined,
  runtimeIdentity: string | undefined,
  allowedSkills?: string[] | 'all',
): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const skills = composeAvailableSkills(undefined, allowedSkills);
  const pieces = [runtimeIdentity, claudeMd, skills, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.model = resolveCodexModel(options.env);
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    pending.push(input.prompt);

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      // Read the per-spawn provider + model from container.json so the
      // config.toml we write reflects whatever /provider or the Models tab
      // last set. Falls back to 'codex' + this.model if container.json is
      // missing, partial, or malformed.
      //
      // container.json is read ONCE here, before the turn loop below — so
      // the resolved model is fixed for the lifetime of this query (one
      // poll-loop batch of pending messages). A model switch made mid-batch
      // is picked up on the *next* query, not the next turn.
      type ContainerJson = {
        provider?: string;
        model?: string;
        skills?: string[] | 'all';
        /**
         * Reasoning effort for codex turns (low|medium|high). Default
         * 'low' — see TurnParams.effort docs in codex-app-server.ts.
         * Set to undefined or omit to let codex use the model's own
         * default (typically 'medium' on gpt-5.x).
         */
        codexEffort?: 'low' | 'medium' | 'high';
      };
      const containerJsonPath = '/workspace/agent/container.json';
      let containerJson: ContainerJson = {};
      try {
        if (fs.existsSync(containerJsonPath)) {
          containerJson = JSON.parse(fs.readFileSync(containerJsonPath, 'utf-8')) as ContainerJson;
        }
      } catch {
        // existsSync passes for a mid-write (partial) file — the Models tab
        // writes container.json from a separate process, a real TOCTOU.
        // Fall back to defaults rather than killing the generator.
        containerJson = {};
      }
      const proxyBaseUrl = (process.env.OPENAI_BASE_URL ?? 'http://host.docker.internal:3001/openai/v1')
        .replace(/\/(openai|omlx)\/v1$/, '');
      const activeProvider = containerJson.provider ?? 'codex';
      const effectiveModel = containerJson.model ?? self.model;
      writeCodexConfigToml({
        mcpServers: self.mcpServers,
        activeProvider,
        model: effectiveModel,
        proxyBaseUrl,
      });
      const server = spawnCodexAppServer(createCodexConfigOverrides());
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;
      let firstTurnConsumed = false;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          // effectiveModel (not self.model) so a model switch made via the
          // Models tab / chat dropdown — written to container.json — takes
          // effect on the next query without respawning the container.
          model: effectiveModel,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(
            input.systemContext?.instructions,
            composeRuntimeIdentity(activeProvider, effectiveModel),
            containerJson.skills,
          ),
        };

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;

          // Images are attached to the FIRST turn only — the initial
          // QueryInput.imagePaths carry the photo the user sent alongside
          // their prompt. Follow-up pending items (system reminders,
          // accumulated context, etc.) are text-only by construction.
          const turnImagePaths = !firstTurnConsumed ? input.imagePaths : undefined;
          firstTurnConsumed = true;

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          yield* runOneTurn(
            server,
            threadId!,
            text,
            effectiveModel,
            input.cwd,
            turnImagePaths,
            containerJson.codexEffort ?? 'low',
            () => initYielded,
            () => {
              initYielded = true;
            },
          );
        }
      } finally {
        killCodexAppServer(server);
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        kick();
      },
      events: gen(),
    };
  }
}

export function resolveCodexModel(env: Record<string, string | undefined> | undefined): string | undefined {
  const model = env?.CODEX_MODEL?.trim();
  return model || undefined;
}

// ── ThreadItem → ProviderEvent translation ──────────────────────────────────
// Codex emits typed ThreadItems via item/started + item/completed. The host's
// trace plumbing (poll-loop.ts:442) speaks the older tool_use/tool_result
// vocabulary the Claude provider has always emitted; we translate so the
// playground trace pane lights up the same way it does for claude agents.
// Non-tool ThreadItem types (reasoning, userMessage, agentMessage, plan,
// hookPrompt, etc.) are intentionally NOT translated — they would either
// duplicate the chat bubble (agentMessage) or flood the trace pane (reasoning).

interface ThreadItemAny {
  type?: string;
  id?: string;
  // commandExecution
  command?: string;
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  status?: string;
  // webSearch
  query?: string;
  action?: unknown;
  // mcpToolCall
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
  // dynamicToolCall
  namespace?: string;
  contentItems?: unknown;
  success?: boolean;
  // fileChange
  changes?: unknown;
}

function toolUseFromItem(item: ThreadItemAny | undefined): ProviderEvent | null {
  if (!item || !item.id) return null;
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_use',
        toolUseId: item.id,
        toolName: 'bash',
        input: { command: item.command ?? '', cwd: item.cwd ?? '' },
      };
    case 'webSearch':
      // query is often empty on item/started — codex fills it in on
      // item/completed. The trace renders what we have either way.
      return {
        type: 'tool_use',
        toolUseId: item.id,
        toolName: 'web_search',
        input: { query: item.query ?? '' },
      };
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        toolUseId: item.id,
        toolName: `mcp:${item.server ?? '?'}.${item.tool ?? '?'}`,
        input: item.arguments ?? null,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_use',
        toolUseId: item.id,
        toolName: `dynamic:${item.tool ?? '?'}`,
        input: item.arguments ?? null,
      };
    case 'fileChange':
      return {
        type: 'tool_use',
        toolUseId: item.id,
        toolName: 'file_change',
        input: { changes: item.changes ?? null },
      };
    default:
      return null;
  }
}

function toolResultFromItem(item: ThreadItemAny | undefined): ProviderEvent | null {
  if (!item || !item.id) return null;
  switch (item.type) {
    case 'commandExecution': {
      const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      return {
        type: 'tool_result',
        toolUseId: item.id,
        content: item.aggregatedOutput ?? '',
        isError: failed,
      };
    }
    case 'webSearch':
      return {
        type: 'tool_result',
        toolUseId: item.id,
        // query becomes meaningful on completion; surface it so trace shows
        // what was actually searched for.
        content: { query: item.query ?? '', action: item.action ?? null },
        isError: item.status === 'failed',
      };
    case 'mcpToolCall':
      return {
        type: 'tool_result',
        toolUseId: item.id,
        content: item.error ? { error: item.error.message ?? 'mcp error' } : item.result ?? null,
        isError: item.status === 'failed' || !!item.error,
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_result',
        toolUseId: item.id,
        content: item.contentItems ?? null,
        isError: item.status === 'failed' || item.success === false,
      };
    case 'fileChange':
      return {
        type: 'tool_result',
        toolUseId: item.id,
        content: { changes: item.changes ?? null },
        isError: item.status === 'failed',
      };
    default:
      return null;
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

export async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string | undefined,
  cwd: string,
  localImagePaths: string[] | undefined,
  effort: 'low' | 'medium' | 'high',
  hasInit: () => boolean,
  markInit: () => void,
): AsyncGenerator<ProviderEvent> {
  const startedAt = Date.now();
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;
  // Per-turn token totals — accumulated from each response's `last` delta
  // (NOT codex's thread-cumulative `total`, which over-counts badly once
  // summed into messages_out). Fed to the end-of-turn `result` event.
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  // Dedup guard: thread/tokenUsage/updated may fire twice for the same LLM
  // response (we saw consecutive identical payloads in the empirical
  // capture). Dedup on the thread-cumulative `total.totalTokens`, which
  // strictly advances per distinct response — so two responses with
  // identical per-response `last` totals are still both counted, while a
  // duplicate notification (unchanged cumulative total) is dropped. (The
  // earlier `last.totalTokens` key wrongly merged two equal-sized responses.)
  let lastSeenCumulativeTotal = -1;
  // Set by item/completed(agentMessage) and consumed once by the next model_call
  // emission so tool-use calls (which produce no agentMessage) don't carry stale text.
  let pendingResponsePreview: string | undefined;

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/started': {
        // Tool invocations begin here. Codex v0.124.0 dropped the legacy
        // tool_use_begin pattern in favor of typed ThreadItems streamed
        // via item/started; we translate to the host's existing
        // tool_use ProviderEvent (poll-loop.ts:442 picks these up and
        // pushes them as kind:'trace' rows for the playground).
        // Skip non-tool item types so the trace pane doesn't fill with
        // reasoning chunks (every codex turn emits dozens) or duplicate
        // userMessage/agentMessage entries the chat bubble already shows.
        const item = params.item as { type?: string; id?: string; [k: string]: unknown } | undefined;
        const ev = toolUseFromItem(item);
        if (ev) buffer.push(ev);
        break;
      }
      case 'item/completed': {
        // Two responsibilities: pick up agentMessage text for resultText
        // (legacy path, preserved verbatim), and emit tool_result events
        // for tool ThreadItems so the playground trace can render
        // completion alongside the tool_use event from item/started.
        const item = params.item as { type?: string; text?: string; id?: string; [k: string]: unknown } | undefined;
        if (item?.type === 'agentMessage' && item.text) {
          resultText = item.text;
          pendingResponsePreview = item.text.slice(0, 5000);
        }
        const ev = toolResultFromItem(item);
        if (ev) buffer.push(ev);
        break;
      }
      case 'turn/completed':
        turnDone = true;
        break;
      case 'thread/tokenUsage/updated': {
        // Replaces the v0.120-era `token_count` notification (which no longer
        // fires in v0.124+). Payload structure:
        //   tokenUsage: { total: {inputTokens, cachedInputTokens, outputTokens,
        //                         reasoningOutputTokens, totalTokens},
        //                 last:  {…same fields, scoped to most recent response},
        //                 modelContextWindow }
        // `total` is THREAD-cumulative — it grows for the whole life of the
        // codex thread, across every turn. Using it for per-turn accounting
        // over-counts badly once messages_out rows are summed. So we ignore
        // `total` entirely and accumulate `last` (this response's delta):
        //   - one `model_call` trace event per distinct `last`, and
        //   - tokensIn/Out/Cached summed across the turn for the `result`
        //     event, which is therefore per-turn, not cumulative.
        // Deduped on last.totalTokens since the notification can fire twice
        // with the same values.
        const usage = params.tokenUsage as
          | { total?: Record<string, number>; last?: Record<string, number> }
          | undefined;
        const last = usage?.last;
        // Prefer the thread-cumulative total as the dedup key; fall back to
        // the per-response total only if codex omits `total` from the payload.
        const dedupKey =
          typeof usage?.total?.totalTokens === 'number'
            ? usage.total.totalTokens
            : typeof last?.totalTokens === 'number'
              ? last.totalTokens
              : undefined;
        if (
          last &&
          typeof last.totalTokens === 'number' &&
          last.totalTokens > 0 &&
          dedupKey !== undefined &&
          dedupKey !== lastSeenCumulativeTotal
        ) {
          lastSeenCumulativeTotal = dedupKey;
          const callIn = typeof last.inputTokens === 'number' ? last.inputTokens : 0;
          const callOut = typeof last.outputTokens === 'number' ? last.outputTokens : 0;
          const callCached = typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : 0;
          tokensIn += callIn;
          tokensOut += callOut;
          tokensCached += callCached;
          const preview = pendingResponsePreview;
          pendingResponsePreview = undefined;
          buffer.push({
            type: 'model_call',
            tokensIn: callIn,
            tokensCached: callCached,
            tokensOut: callOut,
            tokensReasoning:
              typeof last.reasoningOutputTokens === 'number' ? last.reasoningOutputTokens : 0,
            ...(preview ? { responsePreview: preview } : {}),
          });
        }
        break;
      }
      case 'turn/failed': {
        const e = params.error as { message?: string } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        const status = params.status as string | undefined;
        if (status) buffer.push({ type: 'progress', message: `status: ${status}` });
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await startCodexTurn(server, { threadId, inputText, localImagePaths, model, cwd, effort });

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (turnState.error) {
      yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield {
      type: 'result',
      text: resultText || null,
      // Token counts come from thread/tokenUsage/updated notifications (see
      // handler above). Codex's prompt-cache hits land on
      // tokenUsage.total.cachedInputTokens — we forward as cacheRead (OpenAI
      // prefix-cache, billed at 0.5× input). No cacheCreation: OpenAI's
      // prefix cache is automatic and isn't billed at a separate write rate.
      ...(tokensIn > 0 || tokensOut > 0
        ? {
            tokens: {
              input: tokensIn,
              output: tokensOut,
              ...(tokensCached > 0 ? { cacheRead: tokensCached } : {}),
            },
          }
        : {}),
      latencyMs: Date.now() - startedAt,
      provider: 'codex',
      ...(model ? { model } : {}),
    };
  } finally {
    clearTimeout(timer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
// 'local' is codex-app-server pointed at mlx-omni-server; same runtime, different config.toml.
registerProvider('local', (opts) => new CodexProvider(opts));
