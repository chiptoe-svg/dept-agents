#!/usr/bin/env tsx
/**
 * Provision a class from a Google Sheet roster.
 *
 * Sheet schema (Roster!A1:F):
 *   name | email | folder | role | class_token_url | provisioned_at
 *
 *   - `name`, `email`: instructor fills in (required).
 *   - `folder`: blank for auto-assign (`student_01`, `student_02`, …); set
 *     explicitly to override (useful for re-runs that preserve assignment).
 *   - `role`: blank for "student"; also accepts "ta" or "instructor".
 *   - `class_token_url`, `provisioned_at`: script writes these back.
 *
 * Reads the sheet via the Sheets API using the instructor's GWS access
 * token. Provisions any missing agent groups (mirroring class-skeleton.ts's
 * inline provisioning, not by subprocess — we want per-row error isolation).
 * Mints a class-token URL per row, emails it via the host Gmail adapter,
 * writes the URL + timestamp back to the sheet.
 *
 * Idempotent: re-running re-uses existing folders + reissues fresh tokens
 * for any row missing one. Pass --rotate to revoke + reissue every row's
 * token (use for term resets).
 *
 * Usage:
 *   pnpm exec tsx scripts/classroom-roster-sheet.ts --sheet <SHEET_ID> [--rotate] [--course "<name>"]
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { upsertRosterEntry } from '../src/db/classroom-roster.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { addMember, hasMembershipRow } from '../src/modules/permissions/db/agent-group-members.js';
import { issueClassLoginToken, rotateClassLoginToken } from '../src/class-login-tokens.js';
import { sendGmailMessage } from '../src/gmail-send.js';
import { getInstructorGoogleAccessToken } from '../src/gws-token.js';
import { readEnvFile } from '../src/env.js';
import type { AgentGroup } from '../src/types.js';

interface Args {
  sheetId: string;
  rotate: boolean;
  course: string;
  sheetName: string;
  /** Comma-separated allowlist of student emails the script will actually
   * email. Other rows are still provisioned (agent group + roster entry +
   * token rotation) and written back to the sheet, but the Gmail send is
   * skipped. Use during smoke iterations to avoid blasting the full
   * roster while debugging. */
  onlyEmails: string[] | null;
}

const HEADER = ['name', 'email', 'folder', 'role', 'class_token_url', 'provisioned_at'];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sheetId: '',
    rotate: false,
    course: 'your class',
    sheetName: 'Roster',
    onlyEmails: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--sheet') args.sheetId = argv[++i]!;
    else if (a === '--rotate') args.rotate = true;
    else if (a === '--course') args.course = argv[++i]!;
    else if (a === '--sheet-name') args.sheetName = argv[++i]!;
    else if (a === '--only-emails') {
      const raw = argv[++i]!;
      args.onlyEmails = raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm exec tsx scripts/classroom-roster-sheet.ts --sheet <SHEET_ID> [--rotate] [--course "<name>"] [--sheet-name "<tab>"] [--only-emails "a@x,b@y"]',
      );
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!args.sheetId) {
    console.error('--sheet <SHEET_ID> is required (the long string from the sheet URL)');
    process.exit(2);
  }
  return args;
}

interface SheetRow {
  rowIndex: number; // 1-based sheet row number (header is row 1, first data row is 2)
  name: string;
  email: string;
  folder: string;
  role: string; // 'student' | 'ta' | 'instructor'
  classTokenUrl: string;
  provisionedAt: string;
}

async function readSheet(sheetId: string, sheetName: string, token: string): Promise<SheetRow[]> {
  const range = `${sheetName}!A2:F`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { values?: string[][] };
  const rows: SheetRow[] = [];
  (data.values || []).forEach((cols, i) => {
    const [name, email, folder, role, classTokenUrl, provisionedAt] = cols;
    if (!name && !email) return; // skip blank rows
    rows.push({
      rowIndex: i + 2,
      name: (name || '').trim(),
      email: (email || '').trim(),
      folder: (folder || '').trim(),
      role: (role || 'student').trim() || 'student',
      classTokenUrl: (classTokenUrl || '').trim(),
      provisionedAt: (provisionedAt || '').trim(),
    });
  });
  return rows;
}

async function writeBackRow(
  sheetId: string,
  sheetName: string,
  token: string,
  rowIndex: number,
  folder: string,
  classTokenUrl: string,
  provisionedAt: string,
): Promise<void> {
  // Write columns C–F for this row (folder, role unchanged-preserved, url, timestamp).
  // We touch C and E–F; D (role) we leave alone by reading-back via the previous read.
  // Sheets API doesn't support sparse writes in a single call, so do C separately from E:F.
  const updates = [
    { range: `${sheetName}!C${rowIndex}`, values: [[folder]] },
    { range: `${sheetName}!E${rowIndex}:F${rowIndex}`, values: [[classTokenUrl, provisionedAt]] },
  ];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    },
  );
  if (!res.ok) throw new Error(`Sheets write-back failed: ${res.status} ${await res.text()}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function folderForRole(role: string, indexByRole: Record<string, number>): string {
  // Normalize to a canonical lowercase bucket so 'Instructor' and 'instructor'
  // increment the same counter (the previous version bucketed by raw role,
  // which let case-variants collide with the default student bucket).
  const normalized = role.toLowerCase() === 'instructor' ? 'instructor' : role.toLowerCase() === 'ta' ? 'ta' : 'student';
  const n = (indexByRole[normalized] = (indexByRole[normalized] || 0) + 1);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${normalized}_${pad(n)}`;
}

function studentPersona(name: string): string {
  return `# ${name}'s agent\n\nYou are ${name}'s personal class agent. Help with class assignments, research, and questions about course material.\n\n## Resources you have\n\n- \`/workspace/kb/\` — class knowledgebase (read-only). Course material, syllabus, lecture notes. Check here before saying you don't know.\n- \`/workspace/wiki/\` — class wiki (read/write). Shared with all classmates. Contributions are git-attributed to ${name}.\n\n## Customize me\n\nEdit this file in the playground (\`/playground\` on Telegram) to change my persona, behavior, and tone. The default above is just a starting point.\n`;
}

function provisionAgentGroup(folder: string, name: string): AgentGroup {
  let group = getAgentGroupByFolder(folder);
  if (!group) {
    group = {
      id: shortId('ag'),
      name: folder,
      folder,
      agent_provider: null,
      model: null,
      created_at: nowIso(),
    } as AgentGroup;
    createAgentGroup(group);
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const personaPath = path.join(groupDir, 'CLAUDE.local.md');
    if (!fs.existsSync(personaPath)) fs.writeFileSync(personaPath, studentPersona(name));
    // container.json — minimal: provider claude, skills all, no extras.
    const containerJsonPath = path.join(groupDir, 'container.json');
    if (!fs.existsSync(containerJsonPath)) {
      fs.writeFileSync(
        containerJsonPath,
        JSON.stringify(
          {
            mcpServers: {},
            packages: { apt: [], npm: [] },
            additionalMounts: [],
            skills: 'all',
            provider: 'claude',
            groupName: folder,
            assistantName: `${name}'s Agent`,
            agentGroupId: group.id,
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  return group;
}

function userIdForFolder(folder: string): string {
  // Mirrors class-skeleton.ts convention: `class:<folder>`.
  return `class:${folder}`;
}

function publicPlaygroundBaseUrl(): string {
  const url = process.env.PUBLIC_PLAYGROUND_URL || readEnvFile(['PUBLIC_PLAYGROUND_URL']).PUBLIC_PLAYGROUND_URL;
  return (url || 'http://localhost:3002').replace(/\/+$/, '');
}

function buildEmail(name: string, url: string, course: string): { subject: string; body: string } {
  const subject = `Your AI agent for ${course}`;
  const body = [
    `Hi ${name},`,
    '',
    `Your personal AI agent for ${course} is ready. Click the link below to start chatting with it. Bookmark the link — it's how you'll log back in for the rest of the term.`,
    '',
    `→ ${url}`,
    '',
    'On first click you will be asked to enter a 6-digit PIN delivered to this email address. After that, the bookmark alone is enough on the same device.',
    '',
    'If you lose this link, ask your instructor for a fresh one.',
    '',
    `— ${course}`,
  ].join('\n');
  return { subject, body };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const token = await getInstructorGoogleAccessToken();
  if (!token) {
    console.error('No GWS access token — run scripts/gws-authorize.ts first.');
    process.exit(1);
  }

  const rows = await readSheet(args.sheetId, args.sheetName, token);
  console.log(`Read ${rows.length} roster row(s) from sheet ${args.sheetId}`);
  if (rows.length === 0) {
    console.error('Sheet is empty — fill in at least one name/email row under the header.');
    process.exit(1);
  }

  // Assign folders for rows that don't have one, preserving any that do.
  const indexByRole: Record<string, number> = {};
  // First pass: bump indexByRole for existing folders so auto-assigned ones don't collide.
  for (const row of rows) {
    if (!row.folder) continue;
    const match = row.folder.match(/^(student|ta|instructor)_(\d+)$/);
    if (!match) continue;
    const [, role, nStr] = match;
    const n = parseInt(nStr!, 10);
    indexByRole[role!] = Math.max(indexByRole[role!] || 0, n);
  }

  let ok = 0;
  let failed = 0;
  const baseUrl = publicPlaygroundBaseUrl();
  console.log(`Public playground base URL: ${baseUrl}`);

  for (const row of rows) {
    try {
      if (!row.name || !row.email) {
        console.warn(`  [skip] row ${row.rowIndex}: missing name or email`);
        continue;
      }

      // 1. Assign folder if blank.
      const folder = row.folder || folderForRole(row.role, indexByRole);

      // 2. Provision agent group + on-disk dir.
      const group = provisionAgentGroup(folder, row.name);

      // 3. Upsert user + classroom_roster + agent_group_members. Without
      //    the membership row, getPlaygroundAgentForUser falls back to the
      //    first non-draft agent group on login, so the student sees the
      //    wrong agent on the Home tab and the chat post 404s.
      const userId = userIdForFolder(folder);
      upsertUser({ id: userId, kind: 'class', display_name: row.email, created_at: nowIso() });
      upsertRosterEntry({ email: row.email, user_id: userId, agent_group_id: group.id });
      if (!hasMembershipRow(userId, group.id)) {
        addMember({ user_id: userId, agent_group_id: group.id, added_by: null, added_at: nowIso() });
      }

      // 4. Mint or rotate the class-token URL.
      const token =
        args.rotate || !row.classTokenUrl ? rotateClassLoginToken(userId) : extractTokenFromUrl(row.classTokenUrl);
      const url = `${baseUrl}/?token=${token}`;

      // 5. Email it — unless --only-emails filters this row out (provision
      //    + token + write-back still happen so the row is "ready", just
      //    no email is sent during a debug iteration).
      const allow = args.onlyEmails === null || args.onlyEmails.includes(row.email.toLowerCase());
      if (allow) {
        const { subject, body } = buildEmail(row.name, url, args.course);
        await sendGmailMessage({ to: row.email, subject, body });
      } else {
        console.log(`  [no-email] row ${row.rowIndex} (${row.email}) — filtered by --only-emails`);
      }

      // 6. Write back to the sheet.
      await writeBackRow(args.sheetId, args.sheetName, await getFreshToken(), row.rowIndex, folder, url, nowIso());

      const verb = allow ? 'emailed' : 'provisioned (no email)';
      console.log(`  ✓ row ${row.rowIndex} (${row.email} → ${folder}) ${verb}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ row ${row.rowIndex} (${row.email}): ${(err as Error).message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done. ${ok} ok, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

function extractTokenFromUrl(url: string): string {
  const match = url.match(/[?&]token=([A-Za-z0-9_-]+)/);
  return match?.[1] || '';
}

async function getFreshToken(): Promise<string> {
  // Re-fetch in case the original expired during a long roster run.
  const t = await getInstructorGoogleAccessToken();
  if (!t) throw new Error('GWS token unavailable mid-run');
  return t;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
