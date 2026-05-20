import { afterEach, describe, expect, it, vi } from 'vitest';

describe('models API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('GET returns catalog + current whitelist + discovered models', async () => {
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-haiku-4-5', provider: 'claude' }],
    }));
    vi.doMock('../../../container-config.js', () => ({
      readContainerConfig: () => ({
        skills: 'all',
        allowedModels: [{ provider: 'claude', model: 'claude-haiku-4-5' }],
      }),
    }));
    vi.doMock('../../../model-discovery.js', () => ({
      listAllForProvider: vi.fn(async (provider) => {
        if (provider === 'claude') return [{ id: 'claude-opus', alias: 'opus', note: '' }];
        if (provider === 'codex') return [];
        if (provider === 'local') return [];
        return [];
      }),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo');
    expect(result.status).toBe(200);
    const body = result.body as { catalog: unknown[]; allowedModels: unknown[]; discovered: unknown[] };
    expect(body.catalog).toHaveLength(1);
    expect(body.allowedModels).toHaveLength(1);
    expect(body.discovered).toHaveLength(1);
    const discovered = body.discovered as unknown[];
    expect(discovered[0]).toEqual({ provider: 'claude', id: 'claude-opus' });
  });

  it('PUT replaces the whitelist', async () => {
    let written: { allowedModels?: { provider: string; model: string }[] } | undefined;
    vi.doMock('../../../container-config.js', () => ({
      readContainerConfig: () => ({ skills: 'all' }),
      writeContainerConfig: (_folder: string, cfg: { allowedModels?: { provider: string; model: string }[] }) => {
        written = cfg;
      },
    }));
    const { handlePutModels } = await import('./models.js');
    const result = handlePutModels('draft_demo', {
      allowedModels: [{ provider: 'codex', model: 'gpt-5-mini' }],
    });
    expect(result.status).toBe(200);
    expect(written?.allowedModels).toEqual([{ provider: 'codex', model: 'gpt-5-mini' }]);
  });

  it('PUT rejects non-array body', async () => {
    vi.doMock('../../../container-config.js', () => ({
      readContainerConfig: () => ({}),
      writeContainerConfig: () => {},
    }));
    const { handlePutModels } = await import('./models.js');
    expect(handlePutModels('draft_demo', { allowedModels: 'oops' as unknown as never }).status).toBe(400);
  });

  it('PUT rejects entries missing provider or model', async () => {
    vi.doMock('../../../container-config.js', () => ({
      readContainerConfig: () => ({}),
      writeContainerConfig: () => {},
    }));
    const { handlePutModels } = await import('./models.js');
    expect(handlePutModels('draft_demo', { allowedModels: [{ provider: 'claude' } as unknown as never] }).status).toBe(
      400,
    );
  });

  it('PUT /active-model persists model to DB (not just container.json)', async () => {
    const setModelCalls: { folder: string; model: string | null }[] = [];
    vi.doMock('../../../container-config.js', () => ({
      readContainerConfig: () => ({ provider: 'local' }),
      writeContainerConfig: () => {},
    }));
    vi.doMock('../../../model-switch.js', () => ({
      setModel: (folder: string, model: string | null) => {
        setModelCalls.push({ folder, model });
        return true;
      },
    }));
    vi.doMock('../../../provider-switch.js', () => ({ setProvider: () => ({ ok: true, reason: 'no-change' }) }));
    const { handlePutActiveModel } = await import('./models.js');
    const result = handlePutActiveModel('draft_demo', { provider: 'local', model: 'Qwen3.6-35B' });
    expect(result.status).toBe(200);
    expect(setModelCalls).toEqual([{ folder: 'draft_demo', model: 'Qwen3.6-35B' }]);
  });
});
