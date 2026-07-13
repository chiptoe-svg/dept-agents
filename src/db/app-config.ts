import { getDb } from './connection.js';

export function getAppConfig(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAppConfig(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, value, new Date().toISOString());
}

export type DeptModelConfig = {
  defaultCloud: { model: string; provider: string };
  private: { model: string; provider: string };
};

export function getDeptModelConfig(): DeptModelConfig {
  const req = (k: string): string => {
    const v = getAppConfig(k);
    if (v == null) throw new Error(`app_config missing key: ${k}`);
    return v;
  };
  return {
    defaultCloud: { model: req('default_cloud_model'), provider: req('default_cloud_provider') },
    private: { model: req('private_model'), provider: req('private_provider') },
  };
}

export function setDeptModelConfig(cfg: DeptModelConfig): void {
  setAppConfig('default_cloud_model', cfg.defaultCloud.model);
  setAppConfig('default_cloud_provider', cfg.defaultCloud.provider);
  setAppConfig('private_model', cfg.private.model);
  setAppConfig('private_provider', cfg.private.provider);
}
