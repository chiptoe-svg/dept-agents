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
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from '../src/container-config.js';
import { collectSkeletonMounts } from '../src/skeleton-mount-registry.js';
import type { AgentGroup } from '../src/types.js';

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

const STUDENT_PERSONA = (name: string): string => `# ${name}'s agent

You are ${name}'s personal class agent. Help with class assignments,
research, and questions about course material.

## Quirk

End every response with a short dad joke (one line, groan-worthy). The
student can remove this section if they don't like it.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only). Course material,
  syllabus, lecture notes. Check here before saying you don't know.
- \`/workspace/wiki/\` — class wiki (read/write). Shared with all classmates.
  Contributions are git-attributed to ${name}.
- \`/workspace/drive/\` — ${name}'s personal Google Drive folder when the
  Workspace skill is installed. Files saved here sync to ${name}'s Drive.

## Customize me

Edit this file in the playground (\`/playground\` on Telegram) to change my
persona, behavior, and tone. The default above is just a starting point.
`;

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

/**
 * Default content for `data/class-shared-students.md`. Symlinked into
 * each student's group dir as `.class-shared.md`. The instructor can
 * edit this one file to change the class-wide stance for every student.
 *
 * The "How students reach the playground" section reflects the two
 * routes available after Phase 2 of plans/classroom-web-multiuser.md:
 *   - Web (Google sign-in) — preferred for students with a Google
 *     account on the class roster. URL substituted from
 *     PLAYGROUND_PUBLIC_URL at provisioning time.
 *   - Telegram magic link — fallback for instructors and anyone whose
 *     email isn't on the roster yet.
 */
function classSharedStudentMd(): string {
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

const STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./.class-shared.md
@./CLAUDE.local.md
`;

const NON_STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./CLAUDE.local.md
`;

/**
 * Resolve the instructor's currently-active skill set. New student agents
 * inherit from this so the class starts in a consistent skill state. If no
 * instructor agent exists (or the read fails), fall back to the global
 * default (empty list).
 */
function inheritedSkills(): ContainerConfig['skills'] {
  try {
    // Prefer instructor_01 (class instructor convention); fall back to any
    // dm-with-* group (single-user installs without classroom scaffolding).
    const instructor =
      getAgentGroupByFolder('instructor_01') ||
      (getDb()
        .prepare("SELECT * FROM agent_groups WHERE folder LIKE 'dm-with-%' ORDER BY created_at ASC LIMIT 1")
        .get() as AgentGroup | undefined) ||
      null;
    if (instructor) {
      const cfg = readContainerConfig(instructor.folder);
      if (cfg.skills === 'all' || Array.isArray(cfg.skills)) return cfg.skills;
    }
  } catch (err) {
    console.warn('  [warn] inheritedSkills failed, defaulting to empty:', err);
  }
  return [];
}

function makeContainerConfig(opts: {
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
    // Student agents inherit the instructor's currently-active skill set
    // at creation time. TAs / instructors / non-classroom groups use the
    // generic empty default (manual curation via Skills tab afterwards).
    skills: opts.isStudent ? inheritedSkills() : [],
    // All class-skeleton-provisioned groups (students AND TAs) run codex.
    // Class-pool architecture is Codex/OpenAI funded via CLASS_OPENAI_API_KEY;
    // running the Claude SDK for TAs would route their messages through
    // Anthropic. Hard-code 'codex' unconditionally.
    // TODO: make configurable when classes diverge (CLI flag or class-config).
    provider: 'codex',
    groupName: opts.folder,
    assistantName: opts.folder,
  };
}

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
      model: 'gpt-5.4-mini',
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
  writeContainerConfig(
    target.folder,
    makeContainerConfig({
      kb: args.kb,
      wiki: args.wiki,
      folder: target.folder,
      extraMounts,
      isStudent: target.role === 'student',
    }),
  );

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
