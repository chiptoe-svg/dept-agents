/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

// Wrap globalThis.fetch BEFORE any SDK is imported so per-call
// attribution (X-NanoClaw-Agent-Group header on proxy requests) is in
// place from the very first outbound call. See proxy-fetch.ts.
import { installProxyFetch } from './proxy-fetch.js';
installProxyFetch();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

// Canonical per-group persona file, in precedence order. AGENTS.md is the
// cross-tool standard (the playground "Personality" box writes it); the
// legacy CLAUDE.local.md is the fallback until the rest of the plumbing
// migrates. First one that exists with content wins — we do NOT concat the
// two (the legacy file is the old name for the same thing, not a second
// layer). Read here, in the provider-agnostic layer, so every provider gets
// it identically via systemContext.instructions.
const PERSONA_FILES = ['AGENTS.md', 'CLAUDE.local.md'];

function readPersona(dir: string): string {
  for (const name of PERSONA_FILES) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
      if (text) return text;
    } catch {
      /* missing/unreadable — try the next candidate */
    }
  }
  return '';
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.provider) {
    throw new Error('[agent-runner] container.json is missing required field: provider');
  }

  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // System prompt = runtime addendum (agent identity + live destinations map)
  // plus the per-group persona. The persona is composed in HERE, the
  // provider-agnostic layer, rather than via any provider's own
  // AGENTS.md/CLAUDE.md auto-loader: nanoclaw drives several providers and
  // they differ in whether/how they discover project docs (pi, for one,
  // isn't run through its file loader at all). Folding the persona into
  // systemContext.instructions means every provider receives the identical
  // final prompt through the one channel they all consume.
  const addendum = buildSystemPromptAddendum(config.assistantName || undefined);
  const persona = readPersona(CWD);
  const instructions = persona ? `${addendum}\n\n---\n\n${persona}` : addendum;

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.url ?? serverConfig.command})`);
  }

  // Per-group model override from container.json wins over env var. The
  // env var (CODEX_MODEL / ANTHROPIC_MODEL) is the global fallback.
  const envWithModelOverride = { ...process.env };
  if (config.model) {
    envWithModelOverride.CODEX_MODEL = config.model;
    envWithModelOverride.ANTHROPIC_MODEL = config.model;
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: envWithModelOverride,
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model || undefined,
    effort: config.effort,
    // Pi-specific options; single-target providers ignore them.
    // modelProvider comes from container.json if set (the host writes it from
    // container_configs); otherwise pi.ts falls back to 'anthropic' with a warn.
    modelProvider: config.modelProvider,
    // hostMcpUrl + nanoclawSessionId enable pi-mcp-bridge's HTTP bridge to
    // the host-side MCP relay. Set by the host pi.ts container config.
    hostMcpUrl: process.env.NANOCLAW_HOST_MCP_URL || undefined,
    nanoclawSessionId: process.env.NANOCLAW_SESSION_ID || undefined,
  });

  // Pi routes to many upstream model providers (anthropic, openai-codex,
  // openai-platform, local, clemson, …). Each backend keeps its own
  // session/continuation format — anthropic conversation history is not
  // valid input for the OpenAI Responses API and vice versa. Key the
  // continuation slot by `pi:<modelProvider>` so flipping modelProvider
  // naturally starts a fresh session for the new backend instead of
  // replaying the previous backend's items (which produced "Duplicate
  // item found with id msg_3" 400s from chatgpt.com).
  const continuationKey =
    providerName === 'pi' && config.modelProvider
      ? `pi:${String(config.modelProvider).toLowerCase()}`
      : providerName;

  await runPollLoop({
    provider,
    providerName: continuationKey,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
