/**
 * One-off: rewrite every existing student_NN/CLAUDE.local.md with the
 * current STUDENT_PERSONA template. Used when the template changes and
 * existing students need to pick it up (class-skeleton itself only
 * writes the persona file when missing).
 *
 * Reads the student's name from the existing file's H1 ("# <name>'s agent"),
 * so it preserves the name even if the student folder was renamed.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';

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

const folders = fs
  .readdirSync(GROUPS_DIR)
  .filter((f) => /^student_\d+$/.test(f))
  .sort();

let ok = 0;
let skipped = 0;
for (const folder of folders) {
  const file = path.join(GROUPS_DIR, folder, 'CLAUDE.local.md');
  if (!fs.existsSync(file)) {
    console.log(`  [skip] ${folder} — no CLAUDE.local.md`);
    skipped += 1;
    continue;
  }
  const existing = fs.readFileSync(file, 'utf-8');
  const m = existing.match(/^#\s+(.+?)'s agent\s*$/m);
  if (!m) {
    console.log(`  [skip] ${folder} — couldn't parse name from H1`);
    skipped += 1;
    continue;
  }
  const name = m[1]!;
  fs.writeFileSync(file, STUDENT_PERSONA(name));
  console.log(`  [+]    ${folder} (${name})`);
  ok += 1;
}
console.log(`\nRewrote ${ok} persona(s); skipped ${skipped}.`);
