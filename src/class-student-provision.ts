/**
 * Single-student provisioning.
 *
 * `scripts/class-skeleton.ts` bulk-provisions a whole class and is NOT
 * safe to re-run to add one student: its `writeContainerConfig` pass
 * rewrites every student's `container.json`, clobbering per-student
 * customization. This module is the surgical alternative — it touches
 * only the one new `student_NN` folder.
 *
 * Provisioning content now comes from the default-participant slot when
 * one exists (persona, CLAUDE.md, custom-skills, container config), or
 * falls back to the active scenario's `roleProfile` persona + fixed
 * defaults. `makeContainerConfig` and `inheritedSkills` are retained
 * only for the legacy bulk `scripts/class-skeleton.ts` path.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { createAgentGroup, deleteAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { removeRosterEntry, upsertRosterEntry } from './db/classroom-roster.js';
import { getDb } from './db/connection.js';
import { addMember, removeMember } from './modules/permissions/db/agent-group-members.js';
import { deleteUser, upsertUser } from './modules/permissions/db/users.js';
import { materializeContainerJson, type ContainerConfig } from './container-config.js';
import { createContainerConfig } from './db/container-configs.js';
import { collectSkeletonMounts } from './skeleton-mount-registry.js';
// STUDENT_PERSONA now lives with the classroom scenario profile; imported for
// local use (provisionStudent) and re-exported for back-compat with existing
// importers (scripts/class-skeleton, scripts/refresh-student-personas).
import { STUDENT_PERSONA } from './scenarios/classroom/personas.js';
import { folderPrefix, onMemberProvisioned, roleProfile } from './scenarios/registry.js';
import type { CanonicalRole } from './scenarios/types.js';
import type { AgentGroup } from './types.js';
import { slotExists, slotDir, readSlotConfig } from './default-participant-slot.js';
import { copyDirRecursive } from './channels/playground/api/agent-library.js';

export { STUDENT_PERSONA };

// ── Per-student templates (shared with scripts/class-skeleton.ts) ──────────

export const STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./.class-shared.md
@./CLAUDE.local.md
`;

/**
 * Default content for `data/class-shared-students.md` — symlinked into
 * each student's group dir as `.class-shared.md`. Identical to the
 * template `class-skeleton.ts` writes; kept here so a single-student add
 * can recreate the file if it has somehow gone missing.
 */
export function classSharedStudentMd(): string {
  const playgroundUrl = process.env.PLAYGROUND_PUBLIC_URL || process.env.NANOCLAW_PUBLIC_URL || null;
  const webHowto = playgroundUrl
    ? `Visit ${playgroundUrl}/login and sign in with the Google account on the
class roster. You'll land on a home page; click "Open Playground" to
edit my persona, skills, and provider settings.`
    : `(Ask your instructor for the playground URL. Sign in with the Google
account on the class roster.)`;

  return `## How students reach the playground

You can iterate on my persona / skills / provider any time via the
**playground** — a web workbench scoped to your draft.

**Web sign-in (preferred):** ${webHowto}

**Telegram fallback:** if you don't have a Google account on the class
roster, send \`/playground\` to the class bot on Telegram and it will
DM you a magic-link URL that opens the same workbench. Same multi-user
session store as the web path — your session won't kick out anyone
else's.

## How you teach

Approach learning Socratically. When a student asks a question, prefer
asking *them* a question that nudges them toward the answer over
delivering the answer directly. When they're stuck on code, ask what
they've tried. When they're confused about a concept, ask what part is
fuzziest.

Don't be obstructionist — if they truly can't make progress after a
couple of nudges, give the answer with a brief explanation of *why*.
Socratic isn't synonymous with cryptic.

When you do give an answer, frame it so the student can verify it
themselves rather than just trusting you.

## Web hosting

When publishing a website, always use \`/var/www/sites/<your-folder>/<sitename>/\`
where \`<your-folder>\` is your group folder name (e.g. \`student_07\`,
\`ta_03\`, \`instructor_01\`). This keeps your sites separate from your
classmates' sites — never write to \`/var/www/sites/\` directly.

The host's Caddy server serves your site at
\`http://<host>/<your-folder>/<sitename>/\`. Send the URL when done.
`;
}

/**
 * Resolve the instructor's currently-active skill set. New student agents
 * inherit from this so the class stays in a consistent skill state. Falls
 * back to an empty list if no instructor agent exists.
 */
export function inheritedSkills(): ContainerConfig['skills'] {
  try {
    const instructor =
      getAgentGroupByFolder('instructor_01') ||
      (getDb()
        .prepare("SELECT * FROM agent_groups WHERE folder LIKE 'dm-with-%' ORDER BY created_at ASC LIMIT 1")
        .get() as AgentGroup | undefined) ||
      null;
    if (instructor) {
      const cfg = materializeContainerJson(instructor.id);
      if (cfg.skills === 'all' || Array.isArray(cfg.skills)) return cfg.skills;
    }
  } catch (err) {
    console.warn('  [warn] inheritedSkills failed, defaulting to empty:', err);
  }
  return [];
}

/**
 * Build a `container.json` for one class member. Students inherit the
 * instructor's skill set; everyone runs the `codex` provider (the class
 * pool is OpenAI-funded).
 */
export function makeContainerConfig(opts: {
  kb: string | null;
  wiki: string | null;
  folder: string;
  extraMounts: ContainerConfig['additionalMounts'];
  isStudent?: boolean;
}): ContainerConfig {
  const additionalMounts: ContainerConfig['additionalMounts'] = [];
  if (opts.kb) {
    additionalMounts.push({ hostPath: opts.kb, containerPath: '/workspace/kb', readonly: true });
  }
  if (opts.wiki) {
    additionalMounts.push({ hostPath: opts.wiki, containerPath: '/workspace/wiki', readonly: false });
  }
  for (const mount of opts.extraMounts) {
    additionalMounts.push(mount);
  }
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts,
    skills: opts.isStudent ? inheritedSkills() : [],
    // Default provider for new student/class containers. Operator-overridable
    // via NANOCLAW_STUDENT_PROVIDER so a classroom can default to claude / pi
    // / etc. without editing source. Bug fix: pre-fix this was hardcoded to
    // 'codex', so any classroom that wanted a different default had to patch
    // the file. Backward-compatible default preserved.
    provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'codex',
    groupName: opts.folder,
    assistantName: opts.folder,
  };
}

// ── Single-student provisioning ────────────────────────────────────────────

function studentFolder(n: number): string {
  return `student_${String(n).padStart(2, '0')}`;
}

/**
 * Lowest unused `student_NN` folder, scanning existing agent_groups.
 * `student_01` on an empty class, `student_13` after 12 students.
 */
export function nextStudentFolder(): string {
  const rows = getDb().prepare('SELECT folder FROM agent_groups').all() as { folder: string }[];
  let max = 0;
  for (const r of rows) {
    const m = /^student_(\d+)$/.exec(r.folder);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return studentFolder(max + 1);
}

/** Lowest unused `<prefix><n>` folder for `role` under the active scenario. */
export function nextFolderForRole(role: CanonicalRole): string {
  const prefix = folderPrefix(role);
  if (!prefix) throw new Error(`Active scenario has no folder prefix for role "${role}"`);
  const re = new RegExp(`^${prefix}(\\d+)$`);
  const rows = getDb().prepare('SELECT folder FROM agent_groups').all() as { folder: string }[];
  let max = 0;
  for (const r of rows) {
    const m = re.exec(r.folder);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

/** Ensure the symlink target `data/class-shared-students.md` exists. */
function ensureClassSharedTarget(): string {
  const src = path.join(DATA_DIR, 'class-shared-students.md');
  if (!fs.existsSync(src)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(src, classSharedStudentMd());
  }
  return src;
}

export interface ProvisionStudentResult {
  folder: string;
  agentGroupId: string;
  userId: string;
  name: string;
  email: string;
}

/**
 * Generic member provisioning — allocates a folder via the active scenario's
 * prefix for `role`, copies files from the default-participant slot when one
 * exists (else falls back to the scenario's roleProfile persona + fixed
 * defaults), writes DB rows, and calls the scenario's `onMemberProvisioned`
 * hook.
 *
 * All four DB rows go in one transaction — `agent_group_members.user_id`
 * has a FK to `users(id)`, so the `users` row must land first, and a
 * failure must not leave a half-provisioned agent group behind. If the
 * on-disk scaffold then fails, the committed rows are rolled back too,
 * so a retry reissues the same folder rather than orphaning it.
 *
 * The caller is responsible for rejecting duplicate emails — this
 * upserts the roster row unconditionally.
 */
export function provisionMember(opts: {
  role: CanonicalRole;
  name: string;
  email: string;
  addedBy: string | null;
}): ProvisionStudentResult {
  const folder = nextFolderForRole(opts.role);
  const userId = `class:${folder}`;
  const now = new Date().toISOString();
  const group: AgentGroup = {
    id: `ag_${crypto.randomBytes(6).toString('hex')}`,
    name: opts.name,
    folder,
    agent_provider: process.env.NANOCLAW_STUDENT_PROVIDER || 'pi',
    created_at: now,
  };

  // 1. All DB rows in one transaction. Order matters: the agent group
  //    and the member's users row must exist before the membership
  //    row (which FKs both). A throw here commits nothing, so a retry
  //    starts clean instead of tripping the duplicate-email guard.
  getDb().transaction(() => {
    createAgentGroup(group);
    upsertUser({ id: userId, kind: 'class', display_name: opts.email, created_at: now });
    upsertRosterEntry({ email: opts.email, user_id: userId, agent_group_id: group.id });
    addMember({ user_id: userId, agent_group_id: group.id, added_by: opts.addedBy, added_at: now });
  })();

  try {
    // 2. on-disk group dir — persona + composed CLAUDE.md.
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const personaPath = path.join(groupDir, 'CLAUDE.local.md');
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

    // 2a. Persona + CLAUDE.md: slot takes precedence over scenario profile.
    if (slotExists()) {
      const sd = slotDir();
      if (fs.existsSync(path.join(sd, 'CLAUDE.local.md')) && !fs.existsSync(personaPath))
        fs.copyFileSync(path.join(sd, 'CLAUDE.local.md'), personaPath);
      if (fs.existsSync(path.join(sd, 'CLAUDE.md')) && !fs.existsSync(claudeMdPath))
        fs.copyFileSync(path.join(sd, 'CLAUDE.md'), claudeMdPath);
      const slotCustom = path.join(sd, 'custom-skills');
      if (fs.existsSync(slotCustom)) copyDirRecursive(slotCustom, path.join(groupDir, 'custom-skills'));
    } else {
      // Persona comes from the active scenario's role profile. Falls back to
      // STUDENT_PERSONA when no scenario is registered (e.g. unit tests).
      if (!fs.existsSync(personaPath))
        fs.writeFileSync(personaPath, roleProfile(opts.role)?.persona(opts.name) ?? STUDENT_PERSONA(opts.name));
      if (!fs.existsSync(claudeMdPath)) fs.writeFileSync(claudeMdPath, STUDENT_CLAUDE_MD);
    }

    // 3. .class-shared.md symlink → the instructor-editable shared stance.
    const classSharedSrc = ensureClassSharedTarget();
    const classSharedLink = path.join(groupDir, '.class-shared.md');
    if (!fs.existsSync(classSharedLink)) {
      try {
        fs.symlinkSync(classSharedSrc, classSharedLink);
      } catch {
        fs.copyFileSync(classSharedSrc, classSharedLink);
      }
    }

    // 4. container_configs row — slot fields take precedence over env defaults.
    //    Drops inheritedSkills() coupling: no-slot path uses 'all', not owner's skills.
    const sc = slotExists() ? readSlotConfig() : null;
    createContainerConfig({
      agent_group_id: group.id,
      provider: sc?.provider ?? (process.env.NANOCLAW_STUDENT_PROVIDER || 'pi'),
      model: sc?.model ?? (process.env.NANOCLAW_STUDENT_MODEL || 'gpt-5.4-mini'),
      model_provider: sc?.model_provider ?? null,
      effort: sc?.effort ?? null,
      image_tag: null,
      assistant_name: sc?.assistant_name ?? null,
      max_messages_per_prompt: sc?.max_messages_per_prompt ?? null,
      skills: JSON.stringify(sc?.skills ?? 'all'),
      mcp_servers: JSON.stringify(sc?.mcp_servers ?? {}),
      packages_apt: JSON.stringify(sc?.packages_apt ?? []),
      packages_npm: JSON.stringify(sc?.packages_npm ?? []),
      additional_mounts: JSON.stringify(sc?.additional_mounts ?? []),
      cli_scope: 'group',
      env: JSON.stringify(sc?.env ?? {}),
      allowed_models: JSON.stringify(sc?.allowed_models ?? []),
      updated_at: new Date().toISOString(),
    });
    materializeContainerJson(group.id);

    // 5. Post-provision hook (no-op when scenario omits it).
    onMemberProvisioned(folder, { name: opts.name, email: opts.email, role: opts.role });
  } catch (err) {
    // The DB rows are committed but the on-disk scaffold is not. Roll the
    // rows back so a retry reissues this same folder instead of orphaning it.
    // Delete order respects FKs: membership/roster reference users + agent_groups.
    try {
      getDb().transaction(() => {
        removeMember(userId, group.id);
        removeRosterEntry(opts.email);
        deleteUser(userId);
        deleteAgentGroup(group.id);
      })();
    } catch (rollbackErr) {
      console.error('  [error] provisionMember: DB rollback after FS failure also failed:', rollbackErr);
    }
    throw err;
  }

  return { folder, agentGroupId: group.id, userId, name: opts.name, email: opts.email };
}

/**
 * Provision one new student. Thin wrapper around `provisionMember` that
 * fixes `role` to `'user'` so existing callers (students-admin.ts) need
 * no changes.
 */
export function provisionStudent(opts: {
  name: string;
  email: string;
  addedBy: string | null;
}): ProvisionStudentResult {
  return provisionMember({ role: 'user', ...opts });
}
