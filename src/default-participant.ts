/**
 * Default-participant template agent + "save as default".
 *
 * `_default_participant` is a flagged agent group edited via the normal
 * workbench. It is never paired, never a roster member, and roleForFolder
 * returns null for it (no scenario prefix matches '_default_participant').
 * "Save as default" snapshots its files + container_configs into the slot.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import type { AgentGroup } from './types.js';
import {
  createAgentGroup,
  getAllAgentGroups,
  getAgentGroupByFolder,
  setAgentGroupMetadataKey,
} from './db/agent-groups.js';
import {
  createContainerConfig,
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { roleForFolder, roleProfile } from './scenarios/registry.js';
import { copyDirRecursive, saveEntry, writeMeta } from './channels/playground/api/agent-library.js';
import {
  slotDir,
  readSlotConfig,
  writeSlotConfig,
  writeSlotMeta,
  type SlotConfig,
} from './default-participant-slot.js';
import { restartAgentGroupContainers } from './container-restart.js';

export const TEMPLATE_FOLDER = '_default_participant';

export function ensureTemplateAgent(): AgentGroup {
  const existing = getAgentGroupByFolder(TEMPLATE_FOLDER);
  if (existing) return existing;

  const group: AgentGroup = {
    id: `ag_${crypto.randomBytes(6).toString('hex')}`,
    name: 'Default Participant Template',
    folder: TEMPLATE_FOLDER,
    agent_provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'pi',
    created_at: new Date().toISOString(),
  };
  createAgentGroup(group);
  setAgentGroupMetadataKey(group.id, 'template', true);

  const dir = path.join(GROUPS_DIR, TEMPLATE_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const persona = roleProfile('user')?.persona('Participant') ?? '# Participant\n';
  if (!fs.existsSync(path.join(dir, 'CLAUDE.local.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), persona);
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md')))
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Participant agent\n');

  createContainerConfig({
    agent_group_id: group.id,
    provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'pi',
    model: process.env.NANOCLAW_STUDENT_MODEL || 'gpt-5.4-mini',
    model_provider: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: JSON.stringify('all'),
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    env: '{}',
    allowed_models: '[]',
    updated_at: new Date().toISOString(),
  });
  return group;
}

function copyFileIfExists(src: string, dst: string): void {
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

export function saveDefaultFromTemplate(savedBy: string): void {
  const ag = ensureTemplateAgent();
  const dir = path.join(GROUPS_DIR, TEMPLATE_FOLDER);
  const slot = slotDir();
  fs.mkdirSync(slot, { recursive: true });

  copyFileIfExists(path.join(dir, 'CLAUDE.local.md'), path.join(slot, 'CLAUDE.local.md'));
  copyFileIfExists(path.join(dir, 'CLAUDE.md'), path.join(slot, 'CLAUDE.md'));
  const customSrc = path.join(dir, 'custom-skills');
  const customDst = path.join(slot, 'custom-skills');
  fs.rmSync(customDst, { recursive: true, force: true });
  if (fs.existsSync(customSrc)) copyDirRecursive(customSrc, customDst);

  const cfg = getContainerConfig(ag.id);
  const slotCfg: SlotConfig = {
    provider: cfg?.provider ?? null,
    model: cfg?.model ?? null,
    model_provider: (cfg as { model_provider?: string | null } | undefined)?.model_provider ?? null,
    effort: cfg?.effort ?? null,
    assistant_name: cfg?.assistant_name ?? null,
    max_messages_per_prompt: cfg?.max_messages_per_prompt ?? null,
    skills: cfg ? JSON.parse(cfg.skills) : 'all',
    mcp_servers: cfg ? JSON.parse(cfg.mcp_servers) : {},
    packages_apt: cfg ? JSON.parse(cfg.packages_apt) : [],
    packages_npm: cfg ? JSON.parse(cfg.packages_npm) : [],
    additional_mounts: cfg ? JSON.parse(cfg.additional_mounts) : [],
    env: cfg ? JSON.parse(cfg.env) : {},
    allowed_models: cfg ? JSON.parse(cfg.allowed_models) : [],
  };
  writeSlotConfig(slotCfg);
  writeSlotMeta(savedBy);
}

export function applyDefaultToAllParticipants(): { affected: number; restorePoints: string[] } {
  const slot = slotDir();
  const sc = readSlotConfig();
  if (!sc) throw new Error('No default saved — call saveDefaultFromTemplate first');

  const groups = getAllAgentGroups().filter((g) => roleForFolder(g.folder) === 'user');
  const restorePoints: string[] = [];

  for (const g of groups) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = `pre-default-reset-${ts}-${g.folder}`;
    saveEntry(g.folder, slug, true); // restore point (incl. persona)
    const nowIso = new Date().toISOString();
    writeMeta(g.folder, slug, {
      name: 'Before default reset',
      description: `Snapshot taken automatically before the owner applied the default participant template (${nowIso}). Load this to restore your previous persona, CLAUDE.md, and custom skills. (Model/provider settings are not reverted by loading.)`,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    restorePoints.push(slug);

    const gdir = path.join(GROUPS_DIR, g.folder);
    fs.mkdirSync(gdir, { recursive: true });
    copyFileIfExists(path.join(slot, 'CLAUDE.local.md'), path.join(gdir, 'CLAUDE.local.md'));
    copyFileIfExists(path.join(slot, 'CLAUDE.md'), path.join(gdir, 'CLAUDE.md'));
    const customSrc = path.join(slot, 'custom-skills');
    const customDst = path.join(gdir, 'custom-skills');
    fs.rmSync(customDst, { recursive: true, force: true });
    if (fs.existsSync(customSrc)) copyDirRecursive(customSrc, customDst);

    ensureContainerConfig(g.id);
    updateContainerConfigScalars(g.id, {
      provider: sc.provider ?? undefined,
      model: sc.model ?? undefined,
      model_provider: (sc.model_provider ?? undefined) as string | undefined,
      effort: sc.effort ?? undefined,
      assistant_name: sc.assistant_name ?? undefined,
      max_messages_per_prompt: sc.max_messages_per_prompt ?? undefined,
    });
    updateContainerConfigJson(g.id, 'skills', sc.skills);
    updateContainerConfigJson(g.id, 'mcp_servers', sc.mcp_servers);
    updateContainerConfigJson(g.id, 'packages_apt', sc.packages_apt);
    updateContainerConfigJson(g.id, 'packages_npm', sc.packages_npm);
    updateContainerConfigJson(g.id, 'additional_mounts', sc.additional_mounts);
    updateContainerConfigJson(g.id, 'env', sc.env);
    updateContainerConfigJson(g.id, 'allowed_models', sc.allowed_models);

    restartAgentGroupContainers(g.id, 'default-participant-reset');
  }
  return { affected: groups.length, restorePoints };
}
