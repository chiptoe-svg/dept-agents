/**
 * Per-call attribution wrapper for the credential proxy.
 *
 * Monkey-patches `globalThis.fetch` so any request hitting the
 * NanoClaw credential proxy carries an `X-NanoClaw-Agent-Group` header
 * identifying the agent group this container serves. The proxy reads
 * the header and, for `/googleapis/*` (and Phase 4: `/openai/*` +
 * Anthropic), looks up per-student credentials before falling back to
 * the instructor / class-default token.
 *
 * Why monkey-patch: Anthropic SDK + OpenAI SDK + any future SDK pointed
 * at the proxy via `*_BASE_URL` makes its own fetch calls. Wrapping
 * the global means we attribute every outbound proxy call from one
 * place rather than threading the header through each SDK constructor.
 *
 * The wrapper is a no-op if `X_NANOCLAW_AGENT_GROUP` is unset (e.g.
 * during local tests or older container images that the host hasn't
 * been rebuilt against). Missing-header at the proxy gracefully falls
 * back to the class-default credential, so the worst case is "no
 * per-student isolation," not "auth fails."
 *
 * Determining "is this a proxy call": match against the host:port the
 * proxy is bound to. Each container reads `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` at startup; both point at the same host:port (just
 * different path prefixes). We extract that origin from either one and
 * match against it. The Google Workspace relay sits on a different port
 * and `gws.ts` sets the attribution header explicitly, so it doesn't
 * need to be in this match set.
 */

const AGENT_GROUP_HEADER = 'X-NanoClaw-Agent-Group';
const SESSION_ID_HEADER = 'X-NanoClaw-Session-Id';
const AGENT_TOKEN_HEADER = 'x-nanoclaw-agent-token';

function deriveProxyOrigin(): string | null {
  const candidate = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL;
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Wrap globalThis.fetch. Idempotent — calling more than once is a
 * no-op (we tag the wrapped fn so we recognize it).
 */
export function installProxyFetch(): void {
  const wrappedMarker = Symbol.for('nanoclaw.proxy-fetch-installed');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis.fetch as any)?.[wrappedMarker]) return;

  const agentGroupId = process.env.X_NANOCLAW_AGENT_GROUP;
  const sessionId = process.env.X_NANOCLAW_SESSION_ID;
  const agentToken = process.env.X_NANOCLAW_AGENT_TOKEN;
  const proxyOrigin = deriveProxyOrigin();
  // No agent group set OR no proxy origin to match against → nothing to
  // do. (Session id alone is not enough — without an agent group there's
  // nothing existing logic relied on, so we keep the same no-op gate.)
  if (!agentGroupId || !proxyOrigin) return;

  const original = globalThis.fetch;
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    // Require a real boundary after the origin — a bare `startsWith` would
    // also match a hostile service on a prefix-colliding port on the same
    // host (e.g. proxyOrigin `http://host:3001` matching `http://host:30012/...`),
    // leaking the agent token to that service.
    if (url !== proxyOrigin && !url.startsWith(proxyOrigin + '/')) {
      return original(input, init);
    }
    // Build a Headers from whatever shape was passed and add ours.
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    if (!headers.has(AGENT_GROUP_HEADER)) headers.set(AGENT_GROUP_HEADER, agentGroupId);
    if (sessionId && !headers.has(SESSION_ID_HEADER)) headers.set(SESSION_ID_HEADER, sessionId);
    if (agentToken && !headers.has(AGENT_TOKEN_HEADER)) headers.set(AGENT_TOKEN_HEADER, agentToken);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wrapped as any)[wrappedMarker] = true;
  globalThis.fetch = wrapped;
}
