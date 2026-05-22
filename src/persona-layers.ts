import fs from 'fs';
import path from 'path';

import { CONTAINER_DIR, GROUPS_DIR } from './config.js';
import { resolveClaudeImports } from './lib/claude-imports.js';

export interface PersonaLayers {
  /** groups/<folder>/CLAUDE.local.md — the editable per-group persona. */
  myPersona: string;
  /** groups/<folder>/CLAUDE.md after @import resolution — auto-composed group base. */
  groupBase: string;
  /** container/CLAUDE.md — install-wide immutable base, common to every agent. */
  containerBase: string;
  /** groups/global/CLAUDE.md if present — typically absent in v2. */
  global?: string;
}

function readIfExists(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export function getEffectivePersonaLayers(folder: string): PersonaLayers {
  const groupDir = path.join(GROUPS_DIR, folder);
  const myPersona = readIfExists(path.join(groupDir, 'CLAUDE.local.md'));
  // Use .class-shared.md as the canonical class base when present — this is
  // the single instructor-editable file that applies to every seat. Fall back
  // to the full CLAUDE.md resolution for non-classroom installs.
  const classSharedPath = path.join(groupDir, '.class-shared.md');
  const groupBase = fs.existsSync(classSharedPath)
    ? fs.readFileSync(classSharedPath, 'utf-8')
    : (() => {
        const raw = readIfExists(path.join(groupDir, 'CLAUDE.md'));
        return raw ? resolveClaudeImports(raw, groupDir) : '';
      })();
  const containerBase = readIfExists(path.join(CONTAINER_DIR, 'CLAUDE.md'));

  const globalPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  const globalRaw = readIfExists(globalPath);
  const global = globalRaw ? resolveClaudeImports(globalRaw, path.dirname(globalPath)) : undefined;

  return { myPersona, groupBase, containerBase, ...(global !== undefined ? { global } : {}) };
}
