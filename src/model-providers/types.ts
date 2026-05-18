/**
 * Model-provider adapter contract.
 *
 * Each provider (Claude, OpenAI/Codex, Gemini, an OpenAI-compatible custom
 * endpoint, etc.) is one adapter file under `src/model-providers/<name>.ts`
 * that calls `registerModelProvider()` at top level. `model-discovery.ts`
 * dispatches over the registry — adding a new provider requires exactly
 * one new file and one barrel-import line.
 *
 * Adapters are inherently provider-aware (every API shape, id format, and
 * curated note list is provider-specific). The framework's job is to keep
 * that specificity contained: shared interfaces, shared HTTP helper, shared
 * cache. The provider's job is to know how to parse, rank, and authenticate.
 */

/** A single suggested model for the `/model` reply. */
export interface ModelHint {
  /** Full model id sent to the provider. */
  id: string;
  /** Short alias users can type (`opus`, `5.5`). Falls back to `id` when no useful shortening exists. */
  alias: string;
  /** One-line description. Curated where the adapter recognizes the alias; empty otherwise. */
  note: string;
}

/** A model id parsed into a sortable shape. Adapters fill in whatever they need to rank/group. */
export interface ParsedModel {
  /** Full id, unchanged. */
  id: string;
  /** Short alias derived from the id. */
  alias: string;
  /**
   * Sort key — a numeric tuple (newest-first when sorted descending).
   * Adapters convert version components to numbers for stable ordering.
   */
  rank: number[];
  /**
   * Optional grouping bucket for `pickTop` to dedupe within. Claude uses
   * tier name (`opus` / `sonnet` / `haiku`) so the picker takes one per
   * tier rather than three opus variants.
   */
  bucket?: string;
}

/** Auth header name + value for the provider's `/v1/models` call. */
export interface AuthHeader {
  name: string;
  value: string;
}

/** Custom endpoint override for a provider, read from `<NAME>_BASE_URL` env. */
export interface EndpointOverride {
  /** e.g. 'api.openrouter.ai' */
  hostname: string;
  /** Optional port; default 443 */
  port?: number;
}

export interface ModelProviderAdapter {
  /** Provider name as it appears in `agent_groups.agent_provider` / `container.json` `provider`. */
  name: string;

  /** Default API host (e.g. 'api.anthropic.com'). Overridden by `<envBaseUrlVar>` if set. */
  defaultHost: string;

  /**
   * Env var name carrying the custom base URL override. e.g. `ANTHROPIC_BASE_URL`.
   * The proxy uses the same convention; reading it here keeps custom-endpoint
   * setup consistent across credential-proxy + model-discovery.
   */
  envBaseUrlVar: string;

  /** Path on the host for the model list (e.g. '/v1/models'). */
  modelsPath: string;

  /** Static headers always sent (e.g. `anthropic-version`). */
  extraHeaders?: Record<string, string>;

  /** Build the auth header. Returns null if no auth is configured — fetch is skipped, fallback is served. */
  getAuth(): AuthHeader | null;

  /** Parse a raw model id. Return null to skip ids that don't match this adapter's shape. */
  parseId(id: string): ParsedModel | null;

  /**
   * Pick the top N models from the parsed list. Adapters with tiered
   * families (Claude opus/sonnet/haiku) implement bucket-aware logic;
   * flat families (OpenAI gpt-X.Y) just sort by rank descending.
   */
  pickTop(parsed: ParsedModel[], maxCount: number): ParsedModel[];

  /** Curated note for an alias. Return undefined for unknown aliases. */
  noteFor(alias: string): string | undefined;

  /** Static fallback served when the live fetch fails (no auth, network error, etc.). */
  staticFallback: ModelHint[];
}
