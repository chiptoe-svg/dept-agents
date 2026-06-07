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
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { DATA_DIR } from '../../config.js';
import type { ChannelAdapter, ChannelSetup, OutboundFile, OutboundMessage } from '../adapter.js';
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

/**
 * Persistent staging dir for agent-produced files surfaced to the chat tab.
 *
 * The session outbox (`data/v2-sessions/<gid>/<sid>/outbox/<mid>/`) is wiped
 * by `clearOutbox()` immediately after delivery returns, so we copy file
 * bytes here keyed by messageId. The chat tab's `<a download>` link fetches
 * from `/api/drafts/<folder>/files/<messageId>/<filename>` (handled in
 * api-routes.ts), which reads from this same path.
 */
export function playgroundOutboxDir(draftFolder: string, messageId: string): string {
  return path.join(DATA_DIR, 'playground-outbox', draftFolder, messageId);
}

/**
 * Delete staged outbox message dirs older than maxAgeMs. The download links
 * point at these files, so we keep them for a TTL rather than deleting on
 * delivery; this sweep bounds the dir from growing unbounded across a class.
 * Best-effort: any fs error on one entry is logged-as-skip, never thrown.
 */
export function cleanupStaleOutbox(maxAgeMs: number): void {
  const root = path.join(DATA_DIR, 'playground-outbox');
  if (!fs.existsSync(root)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const folderPath = path.join(root, folder.name);
    let removedAll = true;
    for (const msg of fs.readdirSync(folderPath, { withFileTypes: true })) {
      const msgPath = path.join(folderPath, msg.name);
      try {
        if (fs.statSync(msgPath).mtimeMs < cutoff) {
          fs.rmSync(msgPath, { recursive: true, force: true });
        } else {
          removedAll = false;
        }
      } catch {
        removedAll = false;
      }
    }
    // Drop the now-empty folder dir too.
    if (removedAll) {
      try {
        fs.rmdirSync(folderPath);
      } catch {
        /* not empty / race — leave it */
      }
    }
  }
}

function stageOutboundFiles(
  draftFolder: string,
  messageId: string | undefined,
  files: OutboundFile[],
): Array<{ filename: string; url: string }> {
  if (!messageId || !isSafeAttachmentName(messageId)) return [];
  const dir = playgroundOutboxDir(draftFolder, messageId);
  fs.mkdirSync(dir, { recursive: true });
  const staged: Array<{ filename: string; url: string }> = [];
  for (const file of files) {
    if (!isSafeAttachmentName(file.filename)) continue;
    fs.writeFileSync(path.join(dir, file.filename), file.data);
    staged.push({
      filename: file.filename,
      url: `/api/drafts/${encodeURIComponent(draftFolder)}/files/${encodeURIComponent(messageId)}/${encodeURIComponent(file.filename)}`,
    });
  }
  return staged;
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

      const stagedFiles =
        message.files && message.files.length > 0
          ? stageOutboundFiles(draftFolder, message.messageId, message.files)
          : [];

      pushToDraft(draftFolder, 'message', {
        kind: message.kind,
        content: message.content,
        ...(stagedFiles.length > 0 ? { files: stagedFiles } : {}),
        ...(message.messageId ? { messageId: message.messageId } : {}),
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
