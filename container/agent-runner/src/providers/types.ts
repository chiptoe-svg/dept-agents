export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /** Explicit model override — takes priority over user Claude Code settings. */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   * Provider-neutral field; only providers that surface a reasoning knob to
   * the upstream model consume it.
   */
  effort?: string;
  /**
   * Upstream model-provider routing id (`anthropic`, `openai`, `openai-codex`,
   * `deepseek`, `groq`, ...). Used by providers that route to multiple upstream
   * APIs (pi). Single-target providers (claude-sdk, codex) ignore this.
   */
  modelProvider?: string;
  /**
   * Auth-mode hint for providers that distinguish (`api_key` / `oauth` /
   * `subscription` / `native` / `auto`). Pi consults this to pick which env
   * var to read for Anthropic.
   */
  authMode?: 'auto' | 'api_key' | 'subscription' | 'oauth' | 'native';
  /**
   * When a message arrives mid-turn, inject it into the active turn's
   * steering queue (agent re-plans at the next tool-call boundary) instead of
   * queueing it as an after-turn follow-up. Defaults to true; pi-only.
   */
  midTurnSteering?: boolean;
  /** URL of the host-side MCP server (for pi's HTTP bridge). */
  hostMcpUrl?: string;
  /** Session identifier passed to host MCP server. */
  nanoclawSessionId?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * Container-visible absolute paths to image files attached to this turn.
   * Populated by the formatter from inbound `content.images[]` (see
   * src/channels/telegram.ts:processForkAttachments on the host). Providers
   * with vision support forward these to the upstream model — codex via
   * `local_image` UserInput items, claude via image content blocks. Text-
   * only providers ignore the array.
   */
  imagePaths?: string[];

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

/**
 * MCP server transport config, as read from container.json. Superset of the
 * host's `src/container-config.ts` McpServerConfig (minus `instructions`,
 * which is host-only — consumed by claude-md-compose, never written into
 * container.json for the runner). Keep the transport fields (command/args/
 * env/url/headers) in sync with the host type.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP MCP server endpoint. Mutually exclusive with `command`. */
  url?: string;
  /** HTTP headers sent on connect; values may reference `${VAR}` — see resolveHeaders. */
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | {
      type: 'result';
      text: string | null;
      /**
       * Token usage as reported by the provider SDK (best-effort; absent if
       * SDK doesn't expose).
       * - `input`: uncached new input tokens (billed at full rate)
       * - `output`: assistant output tokens
       * - `cacheCreation`: Anthropic only. Tokens written to prompt cache,
       *   billed at 1.25× base input rate.
       * - `cacheRead`: tokens served from prompt cache. Both Anthropic and
       *   OpenAI bill at 0.10× base input rate. Codex sets this from
       *   `tokenUsage.total.cachedInputTokens`.
       */
      tokens?: {
        input: number;
        output: number;
        cacheCreation?: number;
        cacheRead?: number;
      };
      /** End-to-end turn latency in milliseconds (query-start → result event timestamp). */
      latencyMs?: number;
      /** Provider id at the moment of completion ("claude" / "codex" / ...). */
      provider?: string;
      /** Model id used for this turn. */
      model?: string;
    }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   */
  | { type: 'compacted'; text: string }
  /**
   * Pi-native event passthrough. When pi is the harness, pi-agent-core's
   * own events are forwarded unchanged so the playground trace panel can
   * render pi's richer vocabulary directly (streaming text, per-tool
   * live updates, thinking deltas). Trace consumers dispatch on
   * `event.type` (the inner pi event type). Kept as `unknown` so this
   * file has no dependency on the pi packages.
   */
  | { type: 'pi_event'; event: unknown };

/**
 * Per-turn usage and cost (best-effort from the provider SDK). Emitted as a
 * separate event by pi after each `harness.prompt()` returns; classroom-side
 * providers fold this into the `result` event's `tokens` field instead.
 */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheWriteCostUsd?: number;
  totalCostUsd?: number;
  model?: string;
  provider?: string;
}
