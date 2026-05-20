import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
// Exported so per-feature modules (class controls, etc.) can resolve
// their config files relative to the install root without each
// re-deriving from process.cwd().
export const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const CONTAINER_DIR = path.resolve(PROJECT_ROOT, 'container');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const LIBRARY_DIR = path.resolve(PROJECT_ROOT, 'library');
export const STUDENT_LIBRARIES_DIR = path.resolve(PROJECT_ROOT, 'data', 'student-libraries');
export const MODEL_CATALOG_LOCAL_PATH = path.resolve(PROJECT_ROOT, 'config', 'model-catalog-local.json');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
export const PLAYGROUND_PORT = parseInt(process.env.PLAYGROUND_PORT || '3002', 10);
export const GWS_MCP_RELAY_PORT = parseInt(process.env.GWS_MCP_RELAY_PORT || '3007', 10);
const playgroundEnv = readEnvFile(['PLAYGROUND_BIND_HOST', 'PLAYGROUND_IDLE_MINUTES', 'PLAYGROUND_ENABLED']);
const playgroundEnabledRaw = (process.env.PLAYGROUND_ENABLED || playgroundEnv.PLAYGROUND_ENABLED || '').toLowerCase();
export const PLAYGROUND_ENABLED = playgroundEnabledRaw === '1' || playgroundEnabledRaw === 'true';
export const PLAYGROUND_IDLE_MS =
  parseInt(process.env.PLAYGROUND_IDLE_MINUTES || playgroundEnv.PLAYGROUND_IDLE_MINUTES || '30', 10) * 60 * 1000;
// Default 0.0.0.0 — exposed beyond loopback. Magic-link auth (rotating
// per /playground command) gates access. Set to 127.0.0.1 if you'd
// rather tunnel via SSH and skip the magic-link flow entirely.
export const PLAYGROUND_BIND_HOST: string =
  process.env.PLAYGROUND_BIND_HOST || playgroundEnv.PLAYGROUND_BIND_HOST || '0.0.0.0';

export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
