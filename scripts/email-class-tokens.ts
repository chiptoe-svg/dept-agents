#!/usr/bin/env tsx
/**
 * Bulk-email class-token URLs to students using the Gmail API.
 *
 * For a fresh classroom deploy: after `class-skeleton.ts` provisions the
 * roster and `ncl class-tokens issue` mints per-student URLs, this script
 * loops the roster and emails each student their bookmarkable URL — sent
 * from the instructor's own Google Workspace account.
 *
 * Idempotent: run twice and it just re-issues / re-sends (each call mints a
 * fresh token via `ncl class-tokens issue --rotate`, so the previous token
 * is revoked — useful for "I lost my email" recovery).
 *
 * Requires:
 *   - ~/.config/gws/credentials.json with the `gmail.modify` scope (the
 *     default GWS scope set requests it; re-authorize via the GWS OAuth
 *     flow if missing — see setup_classroom.md for the prerequisites).
 *   - .env: NANOCLAW_PUBLIC_URL (the URL students will hit; e.g. http://192.168.1.42:3002)
 *   - Roster CSV with at least `name,email` columns
 *   - The `ncl` CLI on PATH (built and pnpm-linked)
 *
 * Usage:
 *   pnpm exec tsx scripts/email-class-tokens.ts --roster ./roster.csv [--dry-run] [--rotate]
 *
 *   --roster <path>   CSV file with name,email header row
 *   --dry-run         Print what would be emailed; don't call Gmail
 *   --rotate          Rotate (mint a fresh) token for each student before emailing
 *                     (use this for re-sends; without it, re-runs reuse the
 *                     existing token if one is already minted)
 *   --course <name>   Course name to use in subject/body (default: "your class")
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

import { sendGmailMessage } from '../src/gmail-send.js';

interface RosterRow {
  name: string;
  email: string;
}

interface Args {
  rosterPath: string;
  dryRun: boolean;
  rotate: boolean;
  course: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rosterPath: '', dryRun: false, rotate: false, course: 'your class' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--roster') args.rosterPath = argv[++i]!;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rotate') args.rotate = true;
    else if (a === '--course') args.course = argv[++i]!;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!args.rosterPath) {
    console.error('--roster <path> is required');
    process.exit(2);
  }
  return args;
}

const USAGE = `Usage: pnpm exec tsx scripts/email-class-tokens.ts --roster <path> [flags]

Flags:
  --roster <path>   CSV file with header row 'name,email' (required)
  --dry-run         Print actions, don't send emails
  --rotate          Mint fresh tokens (revokes previous) before emailing
  --course <name>   Course name in email subject/body (default: "your class")
`;

function readRoster(p: string): RosterRow[] {
  const raw = fs.readFileSync(p, 'utf-8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`roster ${p} is empty`);
  const header = lines[0]!.split(',').map((s) => s.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  if (nameIdx === -1 || emailIdx === -1) {
    throw new Error(`roster ${p} header must include 'name' and 'email' columns; got [${header.join(', ')}]`);
  }
  const rows: RosterRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((s) => s.trim());
    const name = cols[nameIdx] ?? '';
    const email = cols[emailIdx] ?? '';
    if (!name || !email) {
      console.warn(`  skipping incomplete row ${i + 1}: '${lines[i]}'`);
      continue;
    }
    rows.push({ name, email });
  }
  return rows;
}

function mintToken(email: string, rotate: boolean): string {
  // ncl class-tokens issue prints JSON; parse the URL out.
  const verb = rotate ? 'rotate' : 'issue';
  let stdout: string;
  try {
    stdout = execFileSync('ncl', ['class-tokens', verb, '--email', email], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    throw new Error(`ncl class-tokens ${verb} --email ${email} failed: ${(err as Error).message}`);
  }
  // Lazy parse: look for the URL in the output. ncl's output format is
  // currently text; if it changes to JSON, switch to JSON.parse here.
  const urlMatch = stdout.match(/https?:\/\/\S+\?token=\S+/);
  if (!urlMatch) {
    throw new Error(`ncl ${verb} did not emit a URL for ${email}; got: ${stdout.slice(0, 200)}`);
  }
  return urlMatch[0]!;
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  await sendGmailMessage({ to, subject, body: text });
}

function buildEmail(name: string, url: string, course: string): { subject: string; text: string } {
  const subject = `Your AI agent for ${course}`;
  const text = [
    `Hi ${name},`,
    '',
    `Your personal AI agent for ${course} is ready. Click the link below to start chatting with it. Bookmark the link — it's how you'll log back in for the rest of the term.`,
    '',
    `→ ${url}`,
    '',
    'What you can do with your agent:',
    '  • Chat — ask questions, get help with assignments, brainstorm ideas',
    '  • Tune — edit the persona, pick which skills it uses, choose a model',
    '  • Save snapshots — keep different agent configurations for different tasks',
    '',
    'If you lose this link, ask your instructor for a fresh one.',
    '',
    `— ${course}`,
  ].join('\n');
  return { subject, text };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const roster = readRoster(args.rosterPath);

  console.log(`Found ${roster.length} student rows in ${args.rosterPath}.`);
  console.log(args.dryRun ? '[DRY RUN — no emails will be sent]' : '');

  let ok = 0;
  let failed = 0;
  for (const row of roster) {
    try {
      const url = mintToken(row.email, args.rotate);
      const { subject, text } = buildEmail(row.name, url, args.course);
      if (args.dryRun) {
        console.log(`  [DRY] would send to ${row.email} (${row.name}): ${url}`);
      } else {
        await sendEmail(row.email, subject, text);
        console.log(`  ✓ sent to ${row.email} (${row.name})`);
      }
      ok++;
    } catch (err: unknown) {
      console.error(`  ✗ ${row.email}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done. ${ok} ok, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
