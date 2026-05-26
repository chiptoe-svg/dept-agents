import { expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AgentHarness, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent';

import { getPiAuthApiKey } from './pi-auth.js';
import { resolvePiModel } from './pi-model.js';

const DEFAULT_LIVE_PROVIDER = process.env.PI_SMOKE_MODEL_PROVIDER ?? 'openai-codex';
const DEFAULT_LIVE_MODEL = process.env.PI_SMOKE_MODEL ?? 'gpt-5.3-codex';
const DEFAULT_LIVE_AUTH_PATH =
  process.env.PI_SMOKE_AUTH_PATH ??
  (DEFAULT_LIVE_PROVIDER === 'openai-codex'
    ? path.join(process.env.HOME ?? '', '.codex', 'auth.json')
    : undefined);

function getLivePiSmokeConfig(): { provider: string; model: string; authPath?: string } {
  return {
    provider: DEFAULT_LIVE_PROVIDER,
    model: DEFAULT_LIVE_MODEL,
    authPath: DEFAULT_LIVE_AUTH_PATH,
  };
}

function prepareWritableAuthPath(sourcePath: string | undefined): string | undefined {
  if (!sourcePath || !fs.existsSync(sourcePath)) return sourcePath;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-auth-'));
  const writablePath = path.join(tempDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, writablePath);
  return writablePath;
}

test('pi-agent-core constructs an AgentHarness under Bun', async () => {
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ cwd: process.cwd() });
  const harness = new AgentHarness({
    env,
    session,
    model: resolvePiModel({ modelProvider: 'anthropic', model: 'haiku' }),
    tools: createReadOnlyTools(process.cwd()),
    systemPrompt: 'You are a test agent.',
  });

  expect(harness).toBeDefined();
  expect(harness.getModel().provider).toBe('anthropic');
  expect(harness.getThinkingLevel()).toBeDefined();
});

test.skipIf(process.env.RUN_PI_LIVE !== '1')('pi-agent-core runs one real turn under Bun', async () => {
  const config = getLivePiSmokeConfig();
  const authPath = prepareWritableAuthPath(config.authPath);
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ cwd: process.cwd() });
  const harness = new AgentHarness({
    env,
    session,
    model: resolvePiModel({ modelProvider: config.provider, model: config.model }),
    tools: createReadOnlyTools(process.cwd()),
    systemPrompt: 'Use the available tools when asked. Reply with exactly the word OK after the tool result.',
    streamOptions: { cacheRetention: 'short' },
    getApiKeyAndHeaders: async () => {
      const auth = await getPiAuthApiKey(config.provider, authPath);
      if (!auth) {
        throw new Error(
          `No credentials available for Pi smoke provider "${config.provider}". ` +
          'Set PI_SMOKE_MODEL_PROVIDER/PI_SMOKE_AUTH_PATH or the provider API-key env before RUN_PI_LIVE=1.',
        );
      }
      return { apiKey: auth.apiKey };
    },
  });

  const reply = await harness.prompt('Read the package.json in the current directory, then say OK.');
  expect(reply.provider).toBe(config.provider);
  expect(reply.model.length).toBeGreaterThan(0);

  const text = reply.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

  expect(text.toUpperCase()).toContain('OK');
}, 60_000);
