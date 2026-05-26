/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR, CREDENTIAL_PROXY_PORT, GWS_MCP_RELAY_PORT } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { getActiveSessions } from './db/sessions.js';
import { recoverStaleOutboundJournals } from './session-manager.js';
import { ensureContainerRuntimeRunning, cleanupOrphans, PROXY_BIND_HOST } from './container-runtime.js';
import { startCredentialProxy, setStudentCredsHook } from './credential-proxy.js';
// ── classroom-provider-auth:hook-registration START ───────────────────────
import { resolveStudentCreds } from './classroom-provider-resolver.js';
import './providers/claude-spec.js'; // registers claude
import './providers/codex-spec.js'; // registers codex
// ── classroom-provider-auth:hook-registration END ─────────────────────────
import { startGwsMcpRelay, stopGwsMcpRelay } from './gws-mcp-relay.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  onHostReady,
  getHostReadyCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown, onHostReady };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// Class feature is not part of trunk — installs via /add-classroom,
// /add-classroom-gws, /add-classroom-auth (sibling `classroom` branch).
// Each skill appends its own imports here for the registries it
// registers against (codex auth resolver, container env contributor,
// playground draft gate, pair consumer, telegram command).
import './class-pair-greeting.js';
import './class-pair-instructor.js';
import './class-pair-ta.js';
import './class-playground-gate.js';
import './class-container-env.js';
import './class-login-tokens.js';
import './class-telegram-pair.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

let proxyServer: { close: () => void } | null = null;

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1a. One-time backfill: seed container_configs from existing on-disk
  // container.json files. Idempotent — skips groups that already have a
  // config row. See plans/classroom-upstream-catchup-2026-05-25.md Phase B½.
  backfillContainerConfigs();

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 2b. Credential proxy — containers route API calls through this so they
  // never see real secrets. Apple Container has no host-loopback default
  // (bridge100 only exists while a container is running), so PROXY_BIND_HOST
  // must be explicitly set in .env via /convert-to-apple-container.
  if (!PROXY_BIND_HOST) {
    throw new Error('CREDENTIAL_PROXY_HOST is not set in .env. Run /convert-to-apple-container to configure.');
  }
  proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
  setStudentCredsHook(resolveStudentCreds);

  // 2c. GWS MCP relay — host-side Google Workspace tools. Containers reach
  // it via the same host-gateway pattern as the credential proxy; per-call
  // attribution header authenticates the calling agent group. Loopback only.
  await startGwsMcpRelay(PROXY_BIND_HOST);

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
      meta?: import('./delivery.js').ChannelDeliveryMeta,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files, meta });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 4d. Recover any stale `-journal` files on session outbound DBs left by
  // a prior crashed R/W writer. Must run BEFORE delivery polls, which open
  // outbound.db readonly — readonly opens cannot rollback a stale journal
  // and surface as SQLITE_READONLY_ROLLBACK ("attempt to write a readonly
  // database"). A brief R/W open lets SQLite auto-recover and delete the
  // journal cleanly.
  const journalRecovery = recoverStaleOutboundJournals(getActiveSessions());
  if (journalRecovery.recovered > 0 || journalRecovery.failed > 0) {
    log.info('Outbound journal recovery', { ...journalRecovery });
  }

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');

  // 8. Fire onHostReady callbacks (e.g. classroom auto-starting the
  //    playground HTTP server). Best-effort: errors are logged but don't
  //    take the host down — the rest of the stack is already running.
  for (const cb of getHostReadyCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Host-ready callback threw', { err });
    }
  }
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  proxyServer?.close();
  await stopGwsMcpRelay();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
