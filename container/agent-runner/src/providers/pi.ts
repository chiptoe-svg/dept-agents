/**
 * Pi agent harness — provider adapter for pi-agent-core.
 *
 * Architectural notes for classroom (vs. nanoclaw_personal):
 *
 *   1. Credential proxy, not OneCLI gateway.
 *      Personal's pi-auth.ts substitutes credentials at the HTTPS_PROXY layer
 *      via OneCLI. Classroom uses the host's credential-proxy at
 *      `host.docker.internal:3001`, which intercepts at the HTTP layer by
 *      path prefix (`/openai/`, `/googleapis/`, etc.). The container only
 *      needs placeholder env vars present; the proxy rewrites the real
 *      credential onto the outbound request.
 *
 *   2. Option D — native pi event passthrough.
 *      pi-agent-core emits a rich event stream (text deltas, thinking
 *      deltas, per-toolcall lifecycle). Personal lossily translated those
 *      into `partial_text` and `progress` events. Classroom wraps the raw
 *      pi event into `{ type: 'pi_event', event }` and the playground
 *      trace renderer (chat.js) consumes pi's vocabulary directly.
 *      An `activity` event still fires on every pi event for the
 *      poll-loop's idle-timer.
 *
 *   3. Bugs from the personal audit fixed here:
 *      - `PI_SESSIONS_ROOT` env override for the JsonlSessionRepo root
 *        (personal hardcoded `/workspace/pi-sessions`).
 *      - `modelProvider` default to `'anthropic'` with a warning, instead
 *        of throwing inside the auth callback.
 *      - `hostMcpUrl` / `nanoclawSessionId` plumbed through ProviderOptions
 *        so `createPiMcpBridge` can build the HTTP MCP bridge that personal
 *        silently dropped.
 *      - Async-generator wrapper inlined (personal had a no-yield generator
 *        whose for-await wrapper was unreachable).
 *      - Error emission deduplicated to one site — personal fired both an
 *        inner-loop push and an outer-catch push for the same failure.
 */
import {
  AgentHarness,
  AgentHarnessError,
  JsonlSessionRepo,
  calculateContextTokens,
  estimateContextTokens,
  formatSkillsForSystemPrompt,
  type AgentHarnessEvent,
  type JsonlSessionMetadata,
  type Skill,
  type Session as PiSession,
  loadSkills,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createCodingTools } from '@earendil-works/pi-coding-agent';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput, TurnUsage } from './types.js';
import { getPiAuthApiKey } from './pi-auth.js';
import { createPiMcpBridge } from './pi-mcp-bridge.js';
import { resolvePiModel, resolvePiThinkingLevel } from './pi-model.js';
import { createFetchTool } from '../tools/fetch.js';
import { createWebSearchTool } from './pi-tools/web-search.js';

/**
 * Skill dirs in precedence order — pi loads SKILL.md files from each and
 * later entries override earlier on name collision. Classroom doesn't have
 * personal's class.md / agent.md tier system, so we just look in the two
 * standard places: the per-group enabled-skill dir and the per-group
 * workspace skills.
 *
 * `/home/node/.claude/skills` holds the host-synced symlinks for ONLY the
 * skills enabled in this group's container config (each pointing at
 * /app/skills/<name> or /workspace/agent/custom-skills/<name>). Loading
 * from here — not /app/skills directly — is what makes the playground's
 * skill checkboxes actually gate what the agent knows. loadSkills resolves
 * symlinks and skips missing dirs.
 */
function resolveSkillDirs(cwd: string): string[] {
  return ['/home/node/.claude/skills', `${cwd}/skills`];
}

// Skills whose SKILL.md contains this marker are inlined verbatim into every
// system prompt so the agent never has to read a file before using them.
const ESSENTIAL_SKILL_MARKER = /<!--\s*load:\s*essential\s*-->/;
const AUTO_COMPACT_THRESHOLD = 0.70;

const DEFAULT_MODEL_PROVIDER = 'anthropic';
const DEFAULT_SESSIONS_ROOT = '/workspace/pi-sessions';

/**
 * The Claude Code OAuth scope (issued by claude.com OAuth, used in
 * classroom's OAuth mode) is bound to the assertion that the caller IS
 * Claude Code. Anthropic enforces this by rejecting `/v1/messages`
 * requests whose `system` doesn't begin with this exact preamble — the
 * API returns "Invalid bearer token" regardless of token validity.
 *
 * The Claude SDK does an OAuth-to-api-key exchange first and then uses
 * x-api-key (no preamble needed). Pi-ai uses the OAuth token directly
 * via Bearer, so we have to add the preamble ourselves.
 */
const CLAUDE_CODE_OAUTH_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

function maybePrependClaudeCodePreamble(modelProvider: string, systemPrompt: string): string {
  if (modelProvider !== 'anthropic') return systemPrompt;
  // OAuth mode is in play when ANTHROPIC_API_KEY is absent but a Claude Code
  // OAuth token placeholder is set. Mirror the proxy's detection so a
  // future api-key install doesn't get the preamble it doesn't need.
  const oauthMode = !process.env.ANTHROPIC_API_KEY && !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthMode) return systemPrompt;
  if (systemPrompt.startsWith(CLAUDE_CODE_OAUTH_PREAMBLE)) return systemPrompt;
  return systemPrompt ? `${CLAUDE_CODE_OAUTH_PREAMBLE}\n\n${systemPrompt}` : CLAUDE_CODE_OAUTH_PREAMBLE;
}

function isEssentialSkill(skill: Skill): boolean {
  return ESSENTIAL_SKILL_MARKER.test(skill.content);
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is Extract<AssistantMessage['content'][number], { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('');
}

function usageFromReply(message: AssistantMessage): TurnUsage {
  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    inputCostUsd: message.usage.cost.input,
    outputCostUsd: message.usage.cost.output,
    cacheReadCostUsd: message.usage.cost.cacheRead,
    cacheWriteCostUsd: message.usage.cost.cacheWrite,
    totalCostUsd: message.usage.cost.total,
    model: message.model,
    provider: message.provider,
  };
}

/** Empty TurnUsage for per-turn accumulation. */
function newEmptyTurnUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    totalCostUsd: 0,
  };
}

/**
 * Fold one assistant message's usage into the per-turn accumulator. Each
 * model call in a tool-using turn fires its own message_end with its own
 * usage; the playground's AGENT TURN SUM expects the sum across the turn,
 * not just the last call's numbers. Model/provider are stamped from the
 * last seen message so the sum carries a representative attribution.
 */
function accumulateUsage(acc: TurnUsage, message: AssistantMessage): void {
  const u = message.usage;
  if (!u) return;
  acc.inputTokens = (acc.inputTokens ?? 0) + (u.input ?? 0);
  acc.outputTokens = (acc.outputTokens ?? 0) + (u.output ?? 0);
  acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + (u.cacheRead ?? 0);
  acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + (u.cacheWrite ?? 0);
  acc.totalTokens = (acc.totalTokens ?? 0) + (u.totalTokens ?? 0);
  if (u.cost) {
    acc.inputCostUsd = (acc.inputCostUsd ?? 0) + (u.cost.input ?? 0);
    acc.outputCostUsd = (acc.outputCostUsd ?? 0) + (u.cost.output ?? 0);
    acc.cacheReadCostUsd = (acc.cacheReadCostUsd ?? 0) + (u.cost.cacheRead ?? 0);
    acc.cacheWriteCostUsd = (acc.cacheWriteCostUsd ?? 0) + (u.cost.cacheWrite ?? 0);
    acc.totalCostUsd = (acc.totalCostUsd ?? 0) + (u.cost.total ?? 0);
  }
  if (message.model) acc.model = message.model;
  if (message.provider) acc.provider = message.provider;
}

/** Map pi's per-turn TurnUsage onto classroom's result.tokens shape. */
function tokensFromUsage(usage: TurnUsage): {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
} {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    ...(usage.cacheWriteTokens !== undefined ? { cacheCreation: usage.cacheWriteTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheRead: usage.cacheReadTokens } : {}),
  };
}

export function getPiReplyErrorMessage(message: AssistantMessage): string | null {
  const reply = message as AssistantMessage & { stopReason?: string; errorMessage?: string };
  if (reply.stopReason !== 'error') return null;
  if (typeof reply.errorMessage === 'string' && reply.errorMessage.length > 0) {
    return reply.errorMessage;
  }
  return 'Pi provider returned an error';
}

function parseContinuation(raw: string | undefined): JsonlSessionMetadata | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as JsonlSessionMetadata;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.path !== 'string') {
    throw new Error('Invalid Pi continuation payload');
  }
  return parsed;
}

export function formatContextUsageMessage(usage: { used: number; total: number }): string {
  const percent = usage.total > 0 ? Math.round((usage.used / usage.total) * 100) : 0;
  return `Context: ${usage.used.toLocaleString()} / ${usage.total.toLocaleString()} tokens (${percent}%)`;
}

export function composePiSystemPrompt(promptAddendum: string | undefined, skills: Skill[]): string | undefined {
  // Classroom passes the fully composed system prompt via
  // input.systemContext.instructions (claude.ts and codex.ts use it as-is too),
  // so pi just appends its skill content rather than recomposing from
  // workspace files the way personal does.
  const inlineSkills = skills.filter(isEssentialSkill);
  const lazySkills = skills.filter((s) => !isEssentialSkill(s));

  const pieces = [
    promptAddendum,
    ...inlineSkills.map((s) => `### Skill: ${s.name}\n\n${s.content}`),
    lazySkills.length > 0 ? formatSkillsForSystemPrompt(lazySkills) : undefined,
  ].filter((piece): piece is string => Boolean(piece?.trim()));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private activeHarness: AgentHarness | null = null;
  private activeSession: PiSession | null = null;
  private activeModelContextWindow: number | null = null;
  private lastContextUsage: { used: number; total: number } | null = null;

  constructor(private readonly options: ProviderOptions = {}) {}

  async compact(): Promise<string> {
    if (!this.activeHarness || !this.activeSession) {
      return 'No active session.';
    }

    const before = await this.getContextUsage();
    await this.activeHarness.compact();
    const after = await this.getContextUsage();
    if (before && after) {
      const freed = Math.max(before.used - after.used, 0);
      return `Context compacted (${freed.toLocaleString()} tokens freed)`;
    }
    return 'Context compacted.';
  }

  async getContextUsage(): Promise<{ used: number; total: number } | null> {
    if (!this.activeSession || !this.activeModelContextWindow) {
      return this.lastContextUsage;
    }

    try {
      const context = await this.activeSession.buildContext();
      const used = estimateContextTokens(context.messages).tokens;
      const usage = { used, total: this.activeModelContextWindow };
      this.lastContextUsage = usage;
      return usage;
    } catch {
      return this.lastContextUsage;
    }
  }

  isSessionInvalid(err: unknown): boolean {
    if (err instanceof AgentHarnessError) {
      return err.code === 'session';
    }
    const msg = err instanceof Error ? err.message : String(err);
    // "Duplicate item found with id ..." is what OpenAI's Responses API
    // returns when chatgpt.com receives a request whose `input` items
    // collide on id — usually a stale anthropic-shaped continuation
    // replayed into the codex backend. Treat it as a session-format
    // mismatch so the poll-loop drops the continuation and retries
    // with a fresh session.
    return /session.*not found|invalid continuation|ENOENT|not[_ -]?found|duplicate item found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const provider = this;
    const queuedPrompts: string[] = [input.prompt];
    const queue = createEventQueue();
    const options = this.options;
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let activeHarness: AgentHarness | null = null;
    let activeTurn = false;

    const kick = (): void => {
      waiting?.();
      waiting = null;
    };

    // Resolve modelProvider once at query-start with a default-with-warning
    // instead of throwing at request time inside the auth callback. Personal
    // would throw on every turn when modelProvider was omitted from the
    // config — making the failure mode "container hangs on first message"
    // instead of "container falls back to a sensible default".
    //
    // Precedence: options (from container.json modelProvider field, which the
    // host populates from container_configs.model_provider once that column
    // exists) → NANOCLAW_PI_MODEL_PROVIDER env var (the install-local escape
    // hatch via container_configs.env) → DEFAULT_MODEL_PROVIDER.
    let modelProvider = options.modelProvider || process.env.NANOCLAW_PI_MODEL_PROVIDER;
    if (!modelProvider) {
      modelProvider = DEFAULT_MODEL_PROVIDER;
      console.error(
        `[pi] modelProvider not set (container.json or NANOCLAW_PI_MODEL_PROVIDER env). ` +
          `Defaulting to "${DEFAULT_MODEL_PROVIDER}".`,
      );
    }

    // Run the whole query lifecycle in a single async IIFE. Personal had an
    // async generator + a for-await wrapper around it, but the generator never
    // yielded — it only pushed into the queue. The wrapper iteration was
    // therefore unreachable. Inlining the body removes the unreachable code
    // and one layer of indirection.
    void (async () => {
      let bridge: { tools: unknown[]; close: () => Promise<void> } | null = null;
      let unsubscribe: (() => void) | null = null;
      try {
        const env = new NodeExecutionEnv({ cwd: input.cwd, shellEnv: process.env });
        const sessionsRoot = process.env.PI_SESSIONS_ROOT ?? DEFAULT_SESSIONS_ROOT;
        const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
        const continuation = parseContinuation(input.continuation);
        const session = continuation ? await repo.open(continuation) : await repo.create({ cwd: input.cwd });
        const { value: loadedSkills, timedOut: skillsTimedOut } = await withDeadline(
          3_000,
          loadSkills(env, resolveSkillDirs(input.cwd)),
          { skills: [], diagnostics: [] },
        );
        if (skillsTimedOut) {
          console.error('[pi] skill loading timed out — continuing without skills');
          queue.push({ type: 'progress', message: 'Skill loading timed out — continuing without skills' });
        }
        for (const diagnostic of loadedSkills.diagnostics) {
          console.error(`[pi] skill ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`);
        }
        const model = resolvePiModel({
          modelProvider,
          model: options.model,
        });

        // Pi-ai's per-model `baseUrl` is hardcoded to the upstream provider's
        // public endpoint (e.g. https://api.anthropic.com) and the Anthropic
        // adapter does not honor ANTHROPIC_BASE_URL env var. To route pi
        // traffic through classroom's credential-proxy at :3001 (where
        // credentials are substituted on the wire), override the model's
        // baseUrl here. Only done for anthropic so direct providers (deepseek,
        // groq, openai-codex via chatgpt.com, etc.) keep their hardcoded
        // endpoints and use direct API keys via pi-auth.
        if (modelProvider === 'anthropic' && process.env.ANTHROPIC_BASE_URL) {
          (model as { baseUrl?: string }).baseUrl = process.env.ANTHROPIC_BASE_URL;
        }
        bridge = (await createPiMcpBridge({
          mcpServers: options.mcpServers,
          hostMcpUrl: options.hostMcpUrl,
          sessionId: options.nanoclawSessionId,
        })) as { tools: unknown[]; close: () => Promise<void> };

        const harness = new AgentHarness({
          env,
          session,
          model,
          ...(resolvePiThinkingLevel({
            modelProvider,
            effort: options.effort,
          })
            ? {
                thinkingLevel: resolvePiThinkingLevel({
                  modelProvider,
                  effort: options.effort,
                }),
              }
            : {}),
          tools: [
            // fetch_url / web_search ride the agent-browser skill (shown as
            // "Web Search" in the playground): unchecked means the agent has
            // no web tools at all, so the checkboxes mean what they say.
            ...(loadedSkills.skills.some((s) => s.name === 'agent-browser')
              ? [createFetchTool(), createWebSearchTool()]
              : []),
            ...createCodingTools(input.cwd),
            ...(bridge.tools as unknown[]),
          ] as ConstructorParameters<typeof AgentHarness>[0]['tools'],
          resources: { skills: loadedSkills.skills },
          systemPrompt: maybePrependClaudeCodePreamble(
            modelProvider,
            composePiSystemPrompt(input.systemContext?.instructions, loadedSkills.skills) ?? '',
          ),
          streamOptions: { cacheRetention: 'short' },
          getApiKeyAndHeaders: async () => {
            const auth = await getPiAuthApiKey(modelProvider!);
            if (!auth) {
              throw new Error(`No credentials available for Pi model provider: ${modelProvider}`);
            }
            return { apiKey: auth.apiKey };
          },
        });

        activeHarness = harness;
        provider.activeHarness = harness;
        provider.activeSession = session;
        provider.activeModelContextWindow = model.contextWindow;

        // gpt-5.x-codex defaults to text responses on user queries despite having tools.
        // Force tool_choice: "required" whenever the last input item is a user message
        // (new turn, not returning from a tool result) so the model must call a tool first.
        if (modelProvider === 'openai-codex') {
          harness.on('before_provider_payload', async (event) => {
            const payload = event.payload as Record<string, unknown>;
            const tools = payload.tools as Array<unknown> | undefined;
            if (!Array.isArray(tools) || tools.length === 0) return undefined;
            const inputItems = payload.input as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(inputItems) || inputItems.length === 0) return undefined;
            const lastItem = inputItems[inputItems.length - 1];
            if (lastItem?.role === 'user') {
              return { payload: { ...payload, tool_choice: 'required' } };
            }
            return undefined;
          });
        }

        harness.on('context', async (event) => ({
          messages: event.messages.filter((message) => {
            if (message.role !== 'assistant') return true;
            return message.content.some((item) => item.type === 'text' || item.type === 'toolCall');
          }),
        }));

        // Per-turn usage accumulator. harness.prompt() only returns the
        // FINAL AssistantMessage with its own usage; intermediate model
        // calls within the same turn fire message_end events with their
        // own usage. Without accumulating, the result event (and the
        // playground's AGENT TURN SUM) only reports the last call, not
        // the sum across the turn — wildly under-counting cost for
        // multi-call turns (e.g. tool-using turns where each tool result
        // triggers another model call).
        let turnUsageSum = newEmptyTurnUsage();

        // Option D: pass pi's events through unchanged so the playground trace
        // renderer (chat.js) can show streaming text, per-toolcall lifecycle,
        // and thinking blocks. `activity` keeps the poll-loop's idle-timer
        // honest during long runs. Side-effect: accumulate usage from
        // message_end events for the turn-sum fix above.
        // Provider/model attribution stamped onto the turn_start passthrough
        // so the playground can render an 'AGENT CALL provider/model' header
        // at the top of each turn (mirrors the DIRECT CALL header format).
        // pi-agent-core's native turn_start doesn't carry these.
        const turnMeta = { provider: model.provider, model: model.id };

        unsubscribe = harness.subscribe(async (event: AgentHarnessEvent) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            accumulateUsage(turnUsageSum, event.message);
          }
          let outbound: unknown = event;
          if (event.type === 'turn_start') {
            outbound = { ...event, _nanoclawMeta: turnMeta };
          }
          queue.push({ type: 'activity' }, { type: 'pi_event', event: outbound });
        });

        const meta = await session.getMetadata();
        queue.push({ type: 'init', continuation: JSON.stringify(meta) });

        while (!aborted) {
          while (queuedPrompts.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }

          if (aborted) break;
          if (queuedPrompts.length === 0 && ended) break;
          if (queuedPrompts.length === 0) continue;

          const nextPrompt = queuedPrompts.shift()!;
          activeTurn = true;
          // Reset the turn accumulator at the start of each prompt.
          turnUsageSum = newEmptyTurnUsage();
          try {
            const reply = await harness.prompt(nextPrompt);
            const usage = usageFromReply(reply);
            const replyError = getPiReplyErrorMessage(reply);
            if (replyError) {
              queue.push({ type: 'error', message: replyError, retryable: false });
              ended = true;
              break;
            }
            try {
              if (model.contextWindow > 0) {
                const contextUsage = {
                  used: calculateContextTokens(reply.usage),
                  total: model.contextWindow,
                };
                provider.lastContextUsage = contextUsage;
                queue.push({ type: 'progress', message: formatContextUsageMessage(contextUsage) });
                if (contextUsage.used / contextUsage.total >= AUTO_COMPACT_THRESHOLD) {
                  queue.push({ type: 'progress', message: 'Context above 70% — compacting…' });
                  await harness.compact();
                  const after = await provider.getContextUsage();
                  if (after) {
                    provider.lastContextUsage = after;
                    queue.push({ type: 'progress', message: `Compacted. ${formatContextUsageMessage(after)}` });
                  }
                }
              }
            } catch {
              // Best-effort only: context visibility should never break the turn.
            }
            // Prefer the accumulated turn-sum over the final reply's
            // single-call usage. Fall back to the reply when the
            // accumulator is empty (single-call turn, no message_end
            // events captured).
            const finalUsage: TurnUsage =
              turnUsageSum.inputTokens || turnUsageSum.outputTokens
                ? { ...turnUsageSum, provider: usage.provider, model: usage.model }
                : usage;

            queue.push({
              type: 'result',
              text: assistantText(reply),
              tokens: tokensFromUsage(finalUsage),
              provider: finalUsage.provider,
              model: finalUsage.model,
            });
          } finally {
            activeTurn = false;
          }
        }
      } catch (err) {
        // Single error-emission site. Personal had two: one inside the per-turn
        // try/catch and another in this outer IIFE catch, so every provider
        // failure was published twice. Keeping only the outer catch covers both
        // setup-phase failures (auth, session open, etc.) and per-turn failures.
        const message = err instanceof Error ? err.message : String(err);
        queue.push({
          type: 'error',
          message,
          retryable: false,
          classification: err instanceof AgentHarnessError ? err.code : undefined,
        });
      } finally {
        unsubscribe?.();
        activeHarness = null;
        if (bridge) await bridge.close();
        queue.end();
      }
    })();

    return {
      push(message: string) {
        if (aborted) return;
        if (activeHarness && activeTurn) {
          void activeHarness.followUp(message);
          return;
        }
        queuedPrompts.push(message);
        kick();
      },
      end() {
        ended = true;
        kick();
      },
      abort() {
        aborted = true;
        if (activeHarness) {
          void activeHarness.abort();
        }
        kick();
      },
      events: queue.events,
    };
  }
}

interface EventQueue {
  events: AsyncIterable<ProviderEvent>;
  push(...events: ProviderEvent[]): void;
  end(): void;
}

function createEventQueue(): EventQueue {
  const pending: ProviderEvent[] = [];
  let waiting: (() => void) | null = null;
  let done = false;

  return {
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (pending.length > 0) {
            yield pending.shift()!;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
        }
      },
    },
    push(...events: ProviderEvent[]) {
      pending.push(...events);
      waiting?.();
      waiting = null;
    },
    end() {
      done = true;
      waiting?.();
      waiting = null;
    },
  };
}

export async function withDeadline<T>(
  ms: number,
  promise: Promise<T>,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((v) => ({ value: v, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

registerProvider('pi', (options) => new PiProvider(options));
