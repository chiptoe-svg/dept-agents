import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('pi provider container config', () => {
  it('registers and contributes pi-auth mount + NANOCLAW_SESSION_ID env', async () => {
    await import('../providers/pi.js');
    const { getProviderContainerConfig } = await import('../providers/provider-container-registry.js');

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-session-'));
    try {
      const fn = getProviderContainerConfig('pi');
      expect(fn).toBeTypeOf('function');

      const result = fn!({
        sessionDir,
        agentGroupId: 'ag-test',
        hostEnv: {} as NodeJS.ProcessEnv,
      });

      // Pi-auth dir always mounted at /workspace/.pi-auth so pi-auth.ts can
      // read OAuth tokens when running with openai-codex model provider.
      expect(result.mounts).toEqual([
        { hostPath: path.join(sessionDir, 'pi-auth'), containerPath: '/workspace/.pi-auth', readonly: false },
      ]);

      // NANOCLAW_SESSION_ID is derived from sessionDir basename so the
      // container can reach the host MCP relay with per-session attribution.
      expect(result.env).toMatchObject({ NANOCLAW_SESSION_ID: path.basename(sessionDir) });

      // Pi-auth directory was created.
      expect(fs.existsSync(path.join(sessionDir, 'pi-auth'))).toBe(true);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('forwards direct-API keys when present in hostEnv', async () => {
    await import('../providers/pi.js');
    const { getProviderContainerConfig } = await import('../providers/provider-container-registry.js');
    const fn = getProviderContainerConfig('pi')!;

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-session-'));
    try {
      const result = fn({
        sessionDir,
        agentGroupId: 'ag-test',
        hostEnv: {
          DEEPSEEK_API_KEY: 'sk-deepseek-test',
          GROQ_API_KEY: 'sk-groq-test',
        } as NodeJS.ProcessEnv,
      });

      expect(result.env).toMatchObject({
        DEEPSEEK_API_KEY: 'sk-deepseek-test',
        GROQ_API_KEY: 'sk-groq-test',
      });
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
