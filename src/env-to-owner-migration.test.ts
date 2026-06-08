import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-to-owner-mig-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

function writeEnv(content: string) {
  fs.writeFileSync(path.join(tmpRoot, '.env'), content);
}

async function mockOwner(userId: string | null) {
  vi.doMock('./modules/permissions/db/user-roles.js', () => ({
    getOwnerUserId: () => userId,
  }));
}

describe('env-to-owner migration', () => {
  it('writes .env API keys into owner per-user creds and marks done', async () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant\nOPENAI_API_KEY=sk-oai\n');
    await mockOwner('instructor@x.edu');
    const { runEnvToOwnerMigration } = await import('./env-to-owner-migration.js');
    const { loadUserProviderCreds } = await import('./user-provider-auth.js');

    const result = runEnvToOwnerMigration();

    expect(result.ran).toBe(true);
    expect(result.migrated.sort()).toEqual(['claude', 'codex']);
    expect(result.skipped).toEqual([]);
    expect(loadUserProviderCreds('instructor@x.edu', 'claude')?.apiKey?.value).toBe('sk-ant');
    expect(loadUserProviderCreds('instructor@x.edu', 'codex')?.apiKey?.value).toBe('sk-oai');
    expect(fs.existsSync(path.join(tmpRoot, 'data', '.env-to-owner-migration-done'))).toBe(true);
  });

  it('skips a spec id that already has owner creds (no overwrite)', async () => {
    writeEnv('ANTHROPIC_API_KEY=sk-env\n');
    await mockOwner('instructor@x.edu');
    const { runEnvToOwnerMigration } = await import('./env-to-owner-migration.js');
    const { addApiKey, loadUserProviderCreds } = await import('./user-provider-auth.js');
    addApiKey('instructor@x.edu', 'claude', 'sk-card-set'); // already-connected via card

    const result = runEnvToOwnerMigration();

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['claude']);
    expect(loadUserProviderCreds('instructor@x.edu', 'claude')?.apiKey?.value).toBe('sk-card-set');
  });

  it('is a no-op on second run (marker present)', async () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant\n');
    await mockOwner('instructor@x.edu');
    const { runEnvToOwnerMigration } = await import('./env-to-owner-migration.js');

    runEnvToOwnerMigration();
    const second = runEnvToOwnerMigration();

    expect(second.ran).toBe(false);
    expect(second.migrated).toEqual([]);
  });

  it('does NOT mark done when no owner is configured (so it retries next start)', async () => {
    writeEnv('ANTHROPIC_API_KEY=sk-ant\n');
    await mockOwner(null);
    const { runEnvToOwnerMigration } = await import('./env-to-owner-migration.js');

    const result = runEnvToOwnerMigration();

    expect(result.ran).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'data', '.env-to-owner-migration-done'))).toBe(false);
  });

  it('ignores OAuth-only .env entries (CLAUDE_CODE_OAUTH_TOKEN, etc.) — see spec comment', async () => {
    writeEnv('CLAUDE_CODE_OAUTH_TOKEN=oauth-token\n');
    await mockOwner('instructor@x.edu');
    const { runEnvToOwnerMigration } = await import('./env-to-owner-migration.js');
    const { loadUserProviderCreds } = await import('./user-provider-auth.js');

    const result = runEnvToOwnerMigration();

    expect(result.migrated).toEqual([]);
    expect(loadUserProviderCreds('instructor@x.edu', 'claude')).toBeNull();
  });
});
