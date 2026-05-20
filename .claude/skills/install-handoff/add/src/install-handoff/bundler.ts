/**
 * Install handoff bundler.
 *
 * Gathers sensitive files (`.env`, GWS credentials, Codex auth, optionally
 * Claude OAuth creds, optionally a groups/ tarball) into a per-token staging
 * directory under `data/handoffs/<token>/` so the HTTP server can serve them
 * as a single-download bundle.
 *
 * Design notes:
 * - HOME is resolved at call time from process.env.HOME (so tests can override).
 * - DATA_DIR is imported from config (resolved from process.cwd() at startup).
 * - .env is required: missing → throws. All other items are skipped silently
 *   when absent, since the install may legitimately not use GWS/Codex/etc.
 * - Output dir is chmod 0700; every file inside is chmod 0600.
 * - The system `tar` binary is used for groups/ — no new npm deps.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BundleManifest {
  /** Default true: include .env from project root */
  env?: boolean;
  /** Default true: include ~/.config/gws/credentials.json + client_secret.json (skipped silently if missing) */
  gws?: boolean;
  /** Default true: include ~/.codex/auth.json + config.toml (skipped silently if missing) */
  codex?: boolean;
  /** Default false: include ~/.claude/.credentials.json (skipped silently if missing) */
  claudeCreds?: boolean;
  /** Default false: tar+gz the groups/ directory (no session DBs) */
  groups?: boolean;
}

export interface BundleResult {
  /** The data/handoffs/<token>/ dir where files were placed */
  bundleDir: string;
  /** File manifest with sizes — pass straight to issueHandoff(opts.files) */
  files: { name: string; size: number }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve home directory at call time so tests can override process.env.HOME. */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/**
 * Copy src → dest. After a successful copy, chmod the dest to 0600.
 * Returns false (silently) if src does not exist; throws on other errors.
 */
function copySensitive(src: string, dest: string): boolean {
  try {
    fs.copyFileSync(src, dest);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  fs.chmodSync(dest, 0o600);
  return true;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Assemble the handoff bundle for `token` into `data/handoffs/<token>/`.
 * Returns the bundle directory path and a file manifest (name + size).
 *
 * The token string is used only as a directory name segment — this function
 * does not validate or store it. Callers must have already issued the token
 * via the store before calling this.
 */
export function bundleHandoff(token: string, manifest: BundleManifest): BundleResult {
  const bundleDir = path.join(DATA_DIR, 'handoffs', token);

  // Wipe any pre-existing dir for this token (e.g., stale state from a partial
  // earlier attempt) so the final manifest scan returns only this run's files.
  fs.rmSync(bundleDir, { recursive: true, force: true });

  // Create the bundle dir with restricted permissions (0700).
  fs.mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  // mkdirSync with mode may not honour the mode on all platforms for
  // intermediate dirs; explicitly chmod the leaf.
  fs.chmodSync(bundleDir, 0o700);

  const projectRoot = path.dirname(DATA_DIR);
  const home = homeDir();

  // 1. .env (required)
  if (manifest.env !== false) {
    const src = path.join(projectRoot, '.env');
    if (!fs.existsSync(src)) {
      throw new Error('install-handoff: required file .env not found');
    }
    copySensitive(src, path.join(bundleDir, 'env'));
  }

  // 2. GWS credentials (optional, skip silently if absent)
  if (manifest.gws !== false) {
    const gwsDir = path.join(home, '.config', 'gws');
    copySensitive(path.join(gwsDir, 'credentials.json'), path.join(bundleDir, 'gws-credentials.json'));
    copySensitive(path.join(gwsDir, 'client_secret.json'), path.join(bundleDir, 'gws-client_secret.json'));
  }

  // 3. Codex auth (optional, skip silently if absent)
  if (manifest.codex !== false) {
    const codexDir = path.join(home, '.codex');
    copySensitive(path.join(codexDir, 'auth.json'), path.join(bundleDir, 'codex-auth.json'));
    copySensitive(path.join(codexDir, 'config.toml'), path.join(bundleDir, 'codex-config.toml'));
  }

  // 4. Claude OAuth credentials (opt-in, skip silently if absent)
  if (manifest.claudeCreds === true) {
    const src = path.join(home, '.claude', '.credentials.json');
    copySensitive(src, path.join(bundleDir, 'claude-credentials.json'));
  }

  // 5. groups/ tarball (opt-in, skip silently if absent or empty)
  if (manifest.groups === true) {
    const groupsSrc = GROUPS_DIR; // already absolute from config
    if (fs.existsSync(groupsSrc)) {
      const entries = fs.readdirSync(groupsSrc);
      if (entries.length > 0) {
        const outFile = path.join(bundleDir, 'groups.tar.gz');
        // Exclude any groups/*/data/ directories (session state).
        // -C <project-root> groups  — archive as "groups/..." paths.
        execFileSync('tar', [
          'czf',
          outFile,
          '--exclude=*/data',
          '-C',
          projectRoot,
          'groups',
        ]);
        fs.chmodSync(outFile, 0o600);
      }
    }
  }

  // Scan the bundle dir and build the file manifest.
  const entries = fs.readdirSync(bundleDir);
  const files = entries.map((name) => {
    const stat = fs.statSync(path.join(bundleDir, name));
    return { name, size: stat.size };
  });

  log.info('install-handoff: bundle created', {
    token: `${token.slice(0, 8)}...`,
    bundleDir,
    fileCount: files.length,
  });

  return { bundleDir, files };
}
