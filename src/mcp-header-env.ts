import type { McpServerConfig } from './container-config.js';

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Collect the unique env-var names referenced as `${VAR}` in any MCP server's
 * header values.
 *
 * Security tradeoff (see `container-runner.ts` call site for the forwarding
 * side): LLM API keys never enter a container — the credential proxy
 * substitutes them on the wire. MCP header tokens are different: they *do*
 * enter the container env so the in-container pi bridge's `resolveHeaders`
 * can expand `${VAR}` at connect time. That means any agent wired to a
 * credentialed MCP server can read that token straight out of its own
 * environment and use it directly, bypassing the MCP server entirely. The
 * host limits the blast radius by forwarding exactly the vars referenced
 * here — never the whole `.env` — but the token itself is still container-
 * visible for the lifetime of that container.
 *
 * The host forwards exactly these vars (read from `.env`) into the agent
 * container at spawn, so the in-container Pi bridge's `resolveHeaders` can
 * expand them at connect time. The secret lives in `.env` and the transient
 * container env — never as a literal in the DB / committed config.
 */
export function collectMcpHeaderEnvRefs(servers: Record<string, McpServerConfig>): string[] {
  const refs = new Set<string>();
  for (const cfg of Object.values(servers)) {
    if (!cfg.headers) continue;
    for (const value of Object.values(cfg.headers)) {
      for (const match of value.matchAll(REF_RE)) {
        refs.add(match[1]);
      }
    }
  }
  return [...refs];
}
