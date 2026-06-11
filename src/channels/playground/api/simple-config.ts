/**
 * Backend for the "My Agent" simple beginner tab.
 *
 *   GET  /api/simple-config?folder=…  — instructor-curated skill shortlist +
 *                                       model choices (from the default-
 *                                       participant template slot)
 *   PUT  /api/drafts/:folder/name     — student-editable assistant name
 *   POST /api/simple-restart          — recycle the group's container so a
 *                                       panel save takes effect next message
 *
 * Spec: docs/superpowers/specs/2026-06-11-simple-my-agent-tab-design.md
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_DIR } from '../../../config.js';
import { materializeContainerJson } from '../../../container-config.js';
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { readSlotConfig } from '../../../default-participant-slot.js';
import { getModelCatalog } from '../../../model-catalog.js';
import type { ApiResult } from './me.js';

const SKILLS_DIR = path.join(CONTAINER_DIR, 'skills');

export interface SimpleSkill {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

export interface SimpleModel {
  provider: string;
  id: string;
  displayName: string;
}

export interface SimpleConfigResponse {
  agentName: string;
  skills: SimpleSkill[];
  models: SimpleModel[];
  activeModel: { provider: string; id: string } | null;
}

/** `image-gen` → "Image gen". Kebab/snake → spaces, first letter capitalized. */
export function humanizeSkillTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function listContainerSkills(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * First sentence of the SKILL.md frontmatter `description`. Falls back to
 * the humanized name when the file or frontmatter is missing (pdf-reader
 * ships without frontmatter).
 */
function skillDescription(name: string): string {
  try {
    const md = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      for (const line of fm[1]!.split('\n')) {
        const m = line.match(/^description:\s*(.+)$/);
        if (m) {
          const full = m[1]!.trim();
          const sentence = full.match(/^.*?[.!?](?=\s|$)/);
          return sentence ? sentence[0]! : full;
        }
      }
    }
  } catch {
    /* unreadable SKILL.md — fall through to the name */
  }
  return humanizeSkillTitle(name);
}

export function handleGetSimpleConfig(draftFolder: string): ApiResult<SimpleConfigResponse> {
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    const cfg = materializeContainerJson(group.id);

    // Shortlist = the default-participant template's skill list. 'all' or a
    // missing slot → the full container/skills library (the instructor
    // narrows the template to curate).
    const slot = readSlotConfig();
    const slotSkills = slot?.skills;
    const shortlist = Array.isArray(slotSkills)
      ? slotSkills.filter((s): s is string => typeof s === 'string')
      : listContainerSkills();

    const enabledSet = new Set(cfg.skills === 'all' ? listContainerSkills() : cfg.skills);
    const skills: SimpleSkill[] = shortlist.map((name) => ({
      name,
      title: humanizeSkillTitle(name),
      description: skillDescription(name),
      enabled: enabledSet.has(name),
    }));

    // Model choices = the template's allowed_models resolved against the
    // catalog. Empty/missing → the agent's current model as the only entry.
    const catalog = getModelCatalog();
    const displayNameFor = (provider: string, id: string): string =>
      catalog.find((c) => c.modelProvider === provider && c.id === id)?.displayName || id;

    const slotModels = Array.isArray(slot?.allowed_models)
      ? (slot.allowed_models as { provider?: unknown; model?: unknown }[])
      : [];
    const models: SimpleModel[] = [];
    for (const am of slotModels) {
      if (!am || typeof am.provider !== 'string' || typeof am.model !== 'string') continue;
      models.push({ provider: am.provider, id: am.model, displayName: displayNameFor(am.provider, am.model) });
    }

    const activeProvider = cfg.modelProvider || cfg.provider || '';
    const activeModel = cfg.model && activeProvider ? { provider: activeProvider, id: cfg.model } : null;
    if (models.length === 0 && activeModel) {
      models.push({
        provider: activeModel.provider,
        id: activeModel.id,
        displayName: displayNameFor(activeModel.provider, activeModel.id),
      });
    }

    return {
      status: 200,
      body: { agentName: cfg.assistantName || group.name, skills, models, activeModel },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
