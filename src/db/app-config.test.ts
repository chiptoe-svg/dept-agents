import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { getAppConfig, setAppConfig, getDeptModelConfig, setDeptModelConfig } from './app-config.js';

beforeEach(() => {
  const db = initDb(':memory:');
  runMigrations(db);
});

describe('app-config', () => {
  it('seeds the dept model defaults', () => {
    const cfg = getDeptModelConfig();
    expect(cfg.defaultCloud).toEqual({ model: 'qwen3.6-35b-a3b-fp8', provider: 'clemson' });
    expect(cfg.private).toEqual({ model: 'Qwen3.6-35B-A3B-UD-MLX-4bit', provider: 'local' });
  });
  it('round-trips set/get', () => {
    setAppConfig('default_cloud_model', 'glm-5.1-fp8');
    expect(getAppConfig('default_cloud_model')).toBe('glm-5.1-fp8');
  });
  it('setDeptModelConfig writes all four keys', () => {
    setDeptModelConfig({
      defaultCloud: { model: 'a', provider: 'clemson' },
      private: { model: 'b', provider: 'local' },
    });
    const cfg = getDeptModelConfig();
    expect(cfg.defaultCloud.model).toBe('a');
    expect(cfg.private.model).toBe('b');
  });
});
