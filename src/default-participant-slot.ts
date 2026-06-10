/**
 * The "default participant" slot — a stable snapshot under
 * DATA_DIR/config/default-participant/ that provisioning + apply-to-all read.
 * Contains CLAUDE.local.md (persona), CLAUDE.md, custom-skills/, container.json
 * (a serialization of the template's container_configs row), and meta.json.
 * Authoritative config is the DB; container.json here is a portable copy.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

/** Subset of container_configs fields the slot persists (parsed, not JSON-encoded). */
export interface SlotConfig {
  provider: string | null;
  model: string | null;
  model_provider?: string | null;
  effort: string | null;
  assistant_name: string | null;
  max_messages_per_prompt: number | null;
  skills: unknown; // string[] | 'all'
  mcp_servers: unknown;
  packages_apt: unknown;
  packages_npm: unknown;
  additional_mounts: unknown;
  env: unknown;
  allowed_models: unknown;
}

export function slotDir(): string {
  return path.join(DATA_DIR, 'config', 'default-participant');
}

export function slotExists(): boolean {
  return fs.existsSync(path.join(slotDir(), 'meta.json'));
}

export function writeSlotConfig(cfg: SlotConfig): void {
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.writeFileSync(path.join(slotDir(), 'container.json'), JSON.stringify(cfg, null, 2));
}

export function readSlotConfig(): SlotConfig | null {
  const p = path.join(slotDir(), 'container.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SlotConfig;
  } catch {
    return null;
  }
}

export function writeSlotMeta(savedBy: string): void {
  fs.mkdirSync(slotDir(), { recursive: true });
  fs.writeFileSync(
    path.join(slotDir(), 'meta.json'),
    JSON.stringify({ savedAt: new Date().toISOString(), savedBy }, null, 2),
  );
}

export function readSlotMeta(): { savedAt: string; savedBy: string } | null {
  const p = path.join(slotDir(), 'meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as { savedAt: string; savedBy: string };
  } catch {
    return null;
  }
}
