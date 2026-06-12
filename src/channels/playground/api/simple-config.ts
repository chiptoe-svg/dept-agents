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
import { getAgentGroupByFolder, updateAgentGroup } from '../../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../../db/container-configs.js';
import { readSlotConfig } from '../../../default-participant-slot.js';
import { getModelCatalog } from '../../../model-catalog.js';
import type { ApiResult } from './me.js';
import { killGroupContainer } from './agent-library-handlers.js';

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
          const raw = m[1]!.trim();
          // YAML block scalar (>-, |, etc.) — the content is on subsequent
          // indented lines we don't parse; fall through to the name fallback.
          if (raw === '>-' || raw === '>' || raw === '|-' || raw === '|') break;
          const sentence = raw.match(/^.*?[.!?](?=\s|$)/);
          return sentence ? sentence[0]! : raw;
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
    const allSkills = listContainerSkills(); // once: shortlist fallback + 'all' expansion
    const shortlist = Array.isArray(slotSkills)
      ? slotSkills.filter((s): s is string => typeof s === 'string')
      : allSkills;

    const enabledSet = new Set(cfg.skills === 'all' ? allSkills : cfg.skills);
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

/**
 * PUT /api/drafts/:folder/name — set the assistant's display name. Writes
 * the container-config `assistant_name` (system prompt at next spawn) AND
 * the agent group's display name so rosters and /api/me/agent agree.
 */
export function handlePutAgentName(
  draftFolder: string,
  body: { name?: unknown },
): ApiResult<{ ok: true; name: string }> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 40) {
    return { status: 400, body: { error: 'name must be 1–40 characters' } };
  }
  // Students write this straight into the system prompt + roster — reject
  // control chars and invisible/direction-override Unicode.
  if (/[\x00-\x1f\x7f​-‏‪-‮⁠﻿]/.test(name)) {
    return { status: 400, body: { error: 'name contains invalid characters' } };
  }
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    updateContainerConfigScalars(group.id, { assistant_name: name });
    updateAgentGroup(group.id, { name });
    materializeContainerJson(group.id);
    return { status: 200, body: { ok: true, name } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * POST /api/simple-restart — stop the group's running container so the next
 * message respawns with freshly-saved skills/name. A separate endpoint
 * (rather than baking the kill into the skills PUT) because the skills PUT
 * is shared with the advanced Skills tab, where editing shouldn't bounce a
 * working container mid-session.
 */
export function handleSimpleRestart(draftFolder: string): ApiResult<{ ok: true }> {
  try {
    const group = getAgentGroupByFolder(draftFolder);
    if (!group) return { status: 404, body: { error: `Agent group not found: ${draftFolder}` } };
    killGroupContainer(draftFolder, 'simple tab save');
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
