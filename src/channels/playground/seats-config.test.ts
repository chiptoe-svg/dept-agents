import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'playground-seats.json');

describe('resolveSeatPassword', () => {
  const ORIGINAL_ENV = process.env.PLAYGROUND_SEAT_PASSWORD;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../env.js');
    if (ORIGINAL_ENV === undefined) delete process.env.PLAYGROUND_SEAT_PASSWORD;
    else process.env.PLAYGROUND_SEAT_PASSWORD = ORIGINAL_ENV;
  });

  it('falls back to the JSON password when env is unset (backward compat)', async () => {
    delete process.env.PLAYGROUND_SEAT_PASSWORD;
    vi.doMock('../../env.js', () => ({ readEnvFile: () => ({}) }));
    const { resolveSeatPassword } = await import('./seats-config.js');
    expect(resolveSeatPassword('json-secret')).toBe('json-secret');
  });

  it('returns empty when both env and JSON password are unset/empty', async () => {
    delete process.env.PLAYGROUND_SEAT_PASSWORD;
    vi.doMock('../../env.js', () => ({ readEnvFile: () => ({}) }));
    const { resolveSeatPassword } = await import('./seats-config.js');
    expect(resolveSeatPassword('')).toBe('');
  });

  it('process.env.PLAYGROUND_SEAT_PASSWORD takes precedence over a nonempty JSON password', async () => {
    process.env.PLAYGROUND_SEAT_PASSWORD = 'env-secret-123';
    vi.doMock('../../env.js', () => ({ readEnvFile: () => ({}) }));
    const { resolveSeatPassword } = await import('./seats-config.js');
    expect(resolveSeatPassword('json-secret')).toBe('env-secret-123');
  });

  it('falls back to readEnvFile (.env) when process.env is unset', async () => {
    delete process.env.PLAYGROUND_SEAT_PASSWORD;
    vi.doMock('../../env.js', () => ({
      readEnvFile: (keys: string[]) =>
        keys.includes('PLAYGROUND_SEAT_PASSWORD') ? { PLAYGROUND_SEAT_PASSWORD: 'dotenv-secret-456' } : {},
    }));
    const { resolveSeatPassword } = await import('./seats-config.js');
    expect(resolveSeatPassword('json-secret')).toBe('dotenv-secret-456');
  });
});

describe('readSeatsConfig', () => {
  afterEach(() => {
    delete process.env.PLAYGROUND_SEAT_PASSWORD;
  });

  it('with env unset and committed JSON password "" (today\'s behavior), password is empty', async () => {
    delete process.env.PLAYGROUND_SEAT_PASSWORD;
    const { readSeatsConfig } = await import('./seats-config.js');
    const sc = readSeatsConfig();
    expect(sc.password).toBe('');
    expect(!!sc.password).toBe(false); // passwordRequired would be false
  });

  it('never writes the resolved password back to config/playground-seats.json', async () => {
    const before = fs.readFileSync(CONFIG_PATH, 'utf-8');
    process.env.PLAYGROUND_SEAT_PASSWORD = 'test-password-123';
    const { readSeatsConfig } = await import('./seats-config.js');
    readSeatsConfig();
    const after = fs.readFileSync(CONFIG_PATH, 'utf-8');
    expect(after).toBe(before);
  });
});
