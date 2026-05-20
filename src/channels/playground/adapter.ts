/**
 * Playground channel adapter — implements the ChannelAdapter contract
 * the host's channel-registry expects. Side-effect registers itself at
 * module-import time; whoever imports `playground.ts` (which imports
 * this) gets the registration for free.
 *
 * Holds the `setupConfig` private state — `getSetupConfig()` is how
 * `api-routes.ts` reaches it without importing through the
 * top-level barrel (which would form a cycle).
 */
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { pushToDraft } from './sse.js';

const PLATFORM_PREFIX = 'playground:';

let setupConfig: ChannelSetup | null = null;

export function getSetupConfig(): ChannelSetup | null {
  return setupConfig;
}

export function getPlatformPrefix(): string {
  return PLATFORM_PREFIX;
}

function createAdapter(): ChannelAdapter {
  return {
    name: 'playground',
    channelType: 'playground',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
    },

    async teardown(): Promise<void> {
      setupConfig = null;
      // Defer to server module to actually shut HTTP down. The dynamic
      // import avoids a server.ts → adapter.ts → server.ts cycle at
      // module load.
      const { stopPlaygroundServer } = await import('./server.js');
      await stopPlaygroundServer();
    },

    isConnected(): boolean {
      return setupConfig !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const draftFolder = platformId.startsWith(PLATFORM_PREFIX)
        ? platformId.slice(PLATFORM_PREFIX.length)
        : platformId;
      pushToDraft(draftFolder, 'message', {
        kind: message.kind,
        content: message.content,
        ...(message.meta?.tokens ? { tokens: message.meta.tokens } : {}),
        ...(message.meta?.latencyMs != null ? { latencyMs: message.meta.latencyMs } : {}),
        ...(message.meta?.provider ? { provider: message.meta.provider } : {}),
        ...(message.meta?.model ? { model: message.meta.model } : {}),
      });
      return undefined; // no platform message id
    },
  };
}

// Always register the adapter so the router can find it; the HTTP
// server is started separately via `/playground` Telegram command.
registerChannelAdapter('playground', { factory: createAdapter });
