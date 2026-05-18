/**
 * Class-shared Codex auth resolver — Mode A LLM credential pool.
 *
 * In Mode A (shared class workspace), every class agent group should
 * consume a class-funded OpenAI API key, not the instructor's personal
 * ChatGPT subscription. This module:
 *
 *   1. At host startup, reads `CLASS_OPENAI_API_KEY` from `.env`.
 *   2. If set, writes `data/class-codex-auth.json` with the apikey-mode
 *      shape so the codex CLI inside each class container uses it as
 *      its OpenAI Bearer.
 *   3. Registers a Codex auth resolver (higher priority than the
 *      default `instructorHostResolver`) that returns the class
 *      auth.json path for class agent groups (folder prefix
 *      `student_` / `ta_` / `instructor_`).
 *
 * Fallback: if `CLASS_OPENAI_API_KEY` is unset, OR the calling agent
 * group isn't a class group, OR writing the class auth.json failed,
 * this resolver returns null and the chain falls through to
 * `instructorHostResolver` (instructor's personal ChatGPT OAuth). So
 * an instructor running NanoClaw before configuring the class key
 * still has their own agents working — and class agents have a
 * working backup auth if the API key path breaks.
 *
 * Rotation: edit `.env`, restart the host. The auth.json is
 * regenerated at startup from the current env value.
 *
 * File is installed by `/add-classroom` from the `classroom` branch.
 * Not in trunk — per rule 5 (small-trunk-with-skills).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { registerCodexAuthResolver, type CodexAuthResolver } from './providers/codex.js';

const CLASS_AUTH_JSON_PATH = path.join(DATA_DIR, 'class-codex-auth.json');

function isClassFolder(folder: string): boolean {
  return folder.startsWith('student_') || folder.startsWith('ta_') || folder.startsWith('instructor_');
}

function writeClassAuthJson(apiKey: string): void {
  const auth = {
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
    tokens: null,
    last_refresh: null,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CLASS_AUTH_JSON_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
  log.info('Class Codex auth.json written', { path: CLASS_AUTH_JSON_PATH });
}

export const classCodexAuthResolver: CodexAuthResolver = (ctx) => {
  const ag = getAgentGroup(ctx.agentGroupId);
  if (!ag) return null;
  if (!isClassFolder(ag.folder)) return null;
  // Defensive: if the file vanished or was never written (key unset
  // at startup), fall through to the next resolver.
  if (!fs.existsSync(CLASS_AUTH_JSON_PATH)) return null;
  return { name: 'class-pool', path: CLASS_AUTH_JSON_PATH };
};

/**
 * Read `CLASS_OPENAI_API_KEY` from `.env` and write the derived
 * class auth.json. Best-effort — failures are logged but don't crash
 * startup; the resolver will return null and chain falls through.
 *
 * Exported for tests; the side-effect call happens at module import
 * time below.
 */
export function initializeClassAuth(): void {
  const env = readEnvFile(['CLASS_OPENAI_API_KEY']);
  const apiKey = env.CLASS_OPENAI_API_KEY;
  if (!apiKey) {
    log.info('CLASS_OPENAI_API_KEY not set — class codex resolver will fall through to instructor OAuth');
    return;
  }
  try {
    writeClassAuthJson(apiKey);
  } catch (err) {
    log.warn('Failed to write class codex auth.json — falling back to instructor OAuth', { err: String(err) });
  }
}

initializeClassAuth();
registerCodexAuthResolver(classCodexAuthResolver);
