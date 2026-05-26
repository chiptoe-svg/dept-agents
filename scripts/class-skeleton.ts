/**
 * Class skeleton — bulk-provision agent groups for a class.
 *
 * Three role tiers (Phase 12):
 *   - student_NN  — one per student. Default socratic-tutor persona.
 *   - ta_NN       — one per TA. Default TA-assistant persona, scoped admin
 *                   on every student_* and every other ta_* (whole class).
 *   - instructor_NN — one per instructor. Granted global admin on first pair.
 *
 * Provisions DB rows, on-disk group folders, and pairing codes for each
 * member. Optional skills (e.g. /add-classroom-gws) extend this via
 * `class-skeleton-extensions.ts`, which the script imports for side
 * effects so registered contributors can add per-student mounts and
 * mutate class-config fields.
 *
 * Idempotent: re-runnable. Existing agent_groups rows are kept;
 * container.json is overwritten so re-running picks up new mount
 * paths if KB / wiki / extensions change.
 *
 * Usage:
 *   pnpm exec tsx scripts/class-skeleton.ts \
 *     --count 16 \
 *     --names "Alice,Bob,..." \
 *     --tas "Dave,Eve" \
 *     --instructors "Frank,Grace" \
 *     --kb /srv/class-kb \
 *     --wiki /srv/class-wiki \
 *     --roster /srv/class-roster.csv
 *
 * --tas and --instructors are optional (defaults to none).
 *
 * --roster is the email→user_id map the playground's Google OAuth
 * callback consults to decide who's enrolled. CSV: `email,user_id`
 * one per line. Optional `email,user_id` header. UPSERT on email so
 * re-running with the same CSV is idempotent. Without --roster the
 * playground still works for Telegram-paired users (instructors / TAs)
 * but the no-Telegram Google sign-in path will see "not enrolled" for
 * every student.
 *
 * With /add-classroom-gws installed, additional flags `--drive-parent
 * <folder-id>` and `--drive-mount-root <path>` become available.
 *
 * Note: each path used as a bind mount must be in the mount allowlist
 * at `~/.config/nanoclaw/mount-allowlist.json` or the host will refuse
 * to spawn the student container.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createPairing } from '../src/channels/telegram-pairing.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { upsertRosterEntry } from '../src/db/classroom-roster.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { materializeContainerJson } from '../src/container-config.js';
import { createContainerConfig, getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { collectSkeletonMounts } from '../src/skeleton-mount-registry.js';
import type { AgentGroup } from '../src/types.js';
import {
  STUDENT_PERSONA,
  STUDENT_CLAUDE_MD,
  classSharedStudentMd,
  makeContainerConfig,
} from '../src/class-student-provision.js';

import './class-skeleton-extensions.js';

interface ClassMember {
  name: string;
  folder: string;
}

interface CliArgs {
  count: number;
  names: string[];
  tas: string[];
  instructors: string[];
  kb: string | null;
  wiki: string | null;
  roster: string | null; // path to a CSV of `email,user_id` rows
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  const splitNames = (raw: string | null): string[] =>
    raw
      ? raw
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [];
  const count = parseInt(get('--count') || '16', 10);
  const namesRaw = get('--names');
  const names = namesRaw
    ? splitNames(namesRaw)
    : Array.from({ length: count }, (_, i) => `Student${String(i + 1).padStart(2, '0')}`);
  if (names.length !== count) {
    throw new Error(`--count is ${count} but --names has ${names.length} entries`);
  }
  return {
    count,
    names,
    tas: splitNames(get('--tas')),
    instructors: splitNames(get('--instructors')),
    kb: get('--kb'),
    wiki: get('--wiki'),
    roster: get('--roster'),
  };
}

/**
 * Parse a roster CSV mapping authenticated email → canonical user_id.
 * Expected shape: `email,user_id` rows. Optional header row beginning
 * with `email,` is skipped. Blank lines and `# …` comment lines are
 * ignored. Returns parsed rows; the caller decides what to do with them
 * (typically: validate user_ids match provisioned folders, then upsert).
 */
export function parseRosterCsv(text: string): Array<{ email: string; user_id: string }> {
  const rows: Array<{ email: string; user_id: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 2) continue;
    const [email, userId] = cols;
    // Header row: `email,user_id` literal — skip.
    if (email!.toLowerCase() === 'email') continue;
    if (!email || !userId) continue;
    rows.push({ email: email!, user_id: userId! });
  }
  return rows;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function studentFolder(n: number): string {
  return `student_${String(n).padStart(2, '0')}`;
}

function taFolder(n: number): string {
  return `ta_${String(n).padStart(2, '0')}`;
}

function instructorFolder(n: number): string {
  return `instructor_${String(n).padStart(2, '0')}`;
}

const TA_PERSONA = (name: string): string => `# ${name}'s TA agent

You are ${name}, a teaching assistant for this class. Your job is to help
students debug their work, answer questions, and occasionally help the
instructor review submissions.

When a student is stuck, prefer guiding them to the answer over giving
it. When debugging code, walk them through it. When the instructor asks
for a summary, give them concrete details.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only).
- \`/workspace/wiki/\` — class wiki (read/write). Your contributions are
  git-attributed to ${name}.
- You have admin scope on every \`student_*\` agent group: you can read
  their transcripts, edit their persona via \`/playground\`, and DM
  them via the bot.

## Customize me

Edit this file in the playground to change my persona, behavior, and tone.
The default above is just a starting point.
`;

const INSTRUCTOR_PERSONA = (name: string): string => `# ${name}'s instructor agent

You are ${name}, the instructor for this class. You have global admin —
read every student's transcripts, edit shared CLAUDE.md, manage TAs,
provision/remove students.

Use this agent for course-management tasks: drafting announcements,
reviewing submissions, planning the next lecture, etc. Students and TAs
have their own agents for the day-to-day.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only).
- \`/workspace/wiki/\` — class wiki (read/write). Your contributions are
  git-attributed to ${name}.
- Global admin: every agent group is reachable.

## Customize me

Edit this file in the playground to change my persona, behavior, and tone.
The default above is just a starting point.
`;

const NON_STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./CLAUDE.local.md
`;

interface ProvisionTarget {
  name: string;
  folder: string;
  role: 'student' | 'ta' | 'instructor';
  persona: string;
  /** True for student folders so the on-disk CLAUDE.md pulls in
   *  `.class-shared.md` (the socratic stance). TAs/instructors don't
   *  include it — they have a different mental model. */
  includesClassShared: boolean;
}

function provisionGroup(args: CliArgs, classConfig: Record<string, unknown>, target: ProvisionTarget): string {
  // 1. agent_groups row
  let group = getAgentGroupByFolder(target.folder);
  if (group) {
    console.log(`  [skip] ${target.folder} (${target.name}) — agent group already exists`);
  } else {
    group = {
      id: shortId('ag'),
      // Use the student's real name (from class-config.json's `students[].name`)
      // not the folder slug. The folder is the role/identifier; the name is what
      // shows up in the instructor Roster card.
      name: target.name,
      folder: target.folder,
      // Default students to the codex agent provider (matches this fork's
      // class-pool architecture — CLASS_OPENAI_API_KEY funds inference).
      // Leaving agent_provider:null silently falls back to the Claude SDK
      // which calls Anthropic — wrong direction for a Codex class.
      // TODO: make configurable when classes diverge (CLI flag or class-config).
      agent_provider: 'codex',
      created_at: nowIso(),
    } as AgentGroup;
    createAgentGroup(group);
    console.log(`  [+]    ${target.folder} (${target.name}) — agent group ${group.id}`);
  }

  // 2. on-disk group dir
  const groupDir = path.join(GROUPS_DIR, target.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const personaPath = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(personaPath)) {
    fs.writeFileSync(personaPath, target.persona);
  }
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, target.includesClassShared ? STUDENT_CLAUDE_MD : NON_STUDENT_CLAUDE_MD);
  }

  // 3. .class-shared.md symlink (students only). Symlink target lives at
  //    DATA_DIR/class-shared-students.md so instructor edits there
  //    propagate to every student on next session spawn.
  if (target.includesClassShared) {
    const classSharedSrc = path.join(DATA_DIR, 'class-shared-students.md');
    const classSharedLink = path.join(groupDir, '.class-shared.md');
    if (!fs.existsSync(classSharedLink)) {
      try {
        fs.symlinkSync(classSharedSrc, classSharedLink);
      } catch (err) {
        // Filesystems without symlink support fall back to a copy. The
        // instructor still gets the file but loses the auto-propagate
        // behavior — they'd have to re-run the skeleton to update it.
        console.warn(`  [warn] symlink failed for ${target.folder}/.class-shared.md, copying instead:`, err);
        fs.copyFileSync(classSharedSrc, classSharedLink);
      }
    }
  }

  // 4. extension-contributed mounts (Drive, etc.)
  const extraMounts = collectSkeletonMounts({
    studentFolder: target.folder,
    studentName: target.name,
    classConfig,
    argv: process.argv.slice(2),
  });
  const containerConfig = makeContainerConfig({
    kb: args.kb,
    wiki: args.wiki,
    folder: target.folder,
    extraMounts,
    isStudent: target.role === 'student',
  });
  // Re-runnable: overwrite JSON columns if the row exists; create if new.
  if (getContainerConfig(group.id)) {
    updateContainerConfigJson(group.id, 'skills', containerConfig.skills);
    updateContainerConfigJson(group.id, 'mcp_servers', containerConfig.mcpServers);
    updateContainerConfigJson(group.id, 'packages_apt', containerConfig.packages.apt);
    updateContainerConfigJson(group.id, 'packages_npm', containerConfig.packages.npm);
    updateContainerConfigJson(group.id, 'additional_mounts', containerConfig.additionalMounts);
  } else {
    createContainerConfig({
      agent_group_id: group.id,
      provider: containerConfig.provider ?? null,
      model: 'gpt-5.4-mini',
      effort: null,
      image_tag: null,
      assistant_name: containerConfig.assistantName ?? null,
      max_messages_per_prompt: null,
      skills: JSON.stringify(containerConfig.skills),
      mcp_servers: JSON.stringify(containerConfig.mcpServers),
      packages_apt: JSON.stringify(containerConfig.packages.apt),
      packages_npm: JSON.stringify(containerConfig.packages.npm),
      additional_mounts: JSON.stringify(containerConfig.additionalMounts),
      cli_scope: 'group',
      env: JSON.stringify(containerConfig.env ?? {}),
      allowed_models: JSON.stringify(containerConfig.allowedModels ?? []),
      model_provider: null,
      updated_at: new Date().toISOString(),
    });
  }
  materializeContainerJson(group.id);

  return group.id;
}

async function main(): Promise<void> {
  const args = parseArgs();

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const students: ClassMember[] = args.names.map((name, i) => ({ name, folder: studentFolder(i + 1) }));
  const tas: ClassMember[] = args.tas.map((name, i) => ({ name, folder: taFolder(i + 1) }));
  const instructors: ClassMember[] = args.instructors.map((name, i) => ({ name, folder: instructorFolder(i + 1) }));

  console.log(`Provisioning ${students.length} students, ${tas.length} TAs, ${instructors.length} instructors…`);
  if (args.kb) console.log(`  Static KB:           ${args.kb}`);
  if (args.wiki) console.log(`  Wiki:                ${args.wiki}`);
  console.log();

  // Build the class-config blob first so contributors run against the
  // final shape. Persisted after the loop (contributors may mutate it).
  const classConfig: Record<string, unknown> = {
    kb: args.kb,
    wiki: args.wiki,
    students,
    tas,
    instructors,
  };

  // Write data/class-shared-students.md (the socratic + web-hosting
  // template the symlinks point at). Idempotent: only writes if absent
  // so instructor edits aren't clobbered on re-run.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const classSharedPath = path.join(DATA_DIR, 'class-shared-students.md');
  if (!fs.existsSync(classSharedPath)) {
    fs.writeFileSync(classSharedPath, classSharedStudentMd());
  }

  const roster: Array<{ name: string; folder: string; code: string; role: string }> = [];

  // Provision in dependency-friendly order: instructors first (they
  // get global admin on first pair), then TAs (they get scoped admin
  // on every student/ta), then students.
  for (const m of instructors) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'instructor',
      persona: INSTRUCTOR_PERSONA(m.name),
      includesClassShared: false,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'instructor' });
  }

  for (const m of tas) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'ta',
      persona: TA_PERSONA(m.name),
      includesClassShared: false,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'ta' });
  }

  for (const m of students) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'student',
      persona: STUDENT_PERSONA(m.name),
      includesClassShared: true,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'student' });
  }

  const classConfigPath = path.join(DATA_DIR, 'class-config.json');
  fs.writeFileSync(classConfigPath, JSON.stringify(classConfig, null, 2));

  // --roster: populate classroom_roster from operator-supplied CSV. Lets the
  // playground's Google OAuth callback look up authenticated emails against
  // the canonical user_ids the rest of the class skeleton produces. Idempotent
  // re-runs (UPSERT keyed on email).
  if (args.roster) {
    if (!fs.existsSync(args.roster)) {
      throw new Error(`--roster file not found: ${args.roster}`);
    }
    const rows = parseRosterCsv(fs.readFileSync(args.roster, 'utf8'));
    const knownFolders = new Set([
      ...students.map((s) => s.folder),
      ...tas.map((t) => t.folder),
      ...instructors.map((i) => i.folder),
    ]);
    let upserted = 0;
    let warned = 0;
    for (const r of rows) {
      const folderHint = r.user_id.includes(':') ? r.user_id.split(':').slice(1).join(':') : r.user_id;
      if (!knownFolders.has(folderHint)) {
        console.warn(`  [warn] roster row ${r.email} → ${r.user_id}: no provisioned folder matches`);
        warned += 1;
      }
      upsertRosterEntry({ email: r.email, user_id: r.user_id });
      upserted += 1;
    }
    console.log(`Roster ingested:     ${upserted} entries (${warned} warned) from ${args.roster}`);
  }

  // Roster CSV gains a role column.
  const csvPath = path.join(process.cwd(), 'class-roster.csv');
  const lines = ['role,name,folder,pairing_code,instructions'];
  for (const r of roster) {
    lines.push(
      `"${r.role}","${r.name}","${r.folder}","${r.code}","DM @<bot_username> with: ${r.code} <your-email>"`,
    );
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');

  console.log(`\nClass config:        ${classConfigPath}`);
  console.log(`Class-shared (edit): ${classSharedPath}`);
  console.log(`Roster CSV:          ${csvPath}`);
  console.log(`\n${roster.length} pairing codes generated. Distribute to class members.`);
}

// Only run when invoked as a CLI, not when imported by tests.
import { fileURLToPath } from 'url';
const isMainScript = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainScript) {
  main().catch((err) => {
    console.error('class-skeleton failed:', err);
    process.exit(1);
  });
}
