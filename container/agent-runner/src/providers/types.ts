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

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
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
   * Tool invocation by the agent. Providers MUST emit this when the
   * model calls a tool (Bash, file read, MCP, etc.) so the playground
   * trace panel can surface what the agent is doing under the hood.
   * Other delivery surfaces (Telegram, Slack, etc.) drop trace events;
   * they only ever land on a `playground` channel destination.
   */
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  /**
   * Tool result returning to the agent. Paired with a prior tool_use by
   * `toolUseId`. `isError` is the SDK-reported execution outcome (not
   * "the tool reported a failure logically" — that's domain-specific
   * and lives in the content).
   */
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
  /**
   * One round-trip to the underlying LLM (one OpenAI/Anthropic API call).
   * Codex turns may make several of these in sequence — one per agent
   * message, separated by tool execution. Providers SHOULD emit this so
   * the playground trace pane can show per-call breakdowns, not just the
   * cumulative `result` summary at end-of-turn. Tokens are this call's
   * delta, NOT cumulative.
   */
  | {
      type: 'model_call';
      tokensIn: number;
      tokensCached: number;
      tokensOut: number;
      tokensReasoning: number;
      /** Text the model generated for this call (absent on tool-use-only calls). */
      responsePreview?: string;
    };
