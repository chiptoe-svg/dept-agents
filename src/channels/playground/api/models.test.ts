import { afterEach, describe, expect, it, vi } from 'vitest';

describe('models API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('GET returns catalog + current whitelist + discovered models', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-haiku-4-5', provider: 'claude' }],
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({
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
    vi.doMock('../../../model-providers/index.js', () => ({
      getModelProvider: (name: string) => ({
        getAuth: () => (name === 'claude' ? { name: 'x-api-key', value: 'k' } : null),
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

  it('GET reports per-provider auth: cloud via getAuth, local via reachability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [
        { id: 'claude-haiku-4-5', provider: 'claude' },
        { id: 'gpt-5-mini', provider: 'codex' },
        { id: 'Qwen3.6-35B', provider: 'local' },
      ],
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all' }),
    }));
    vi.doMock('../../../model-discovery.js', () => ({
      listAllForProvider: vi.fn(async () => []),
    }));
    vi.doMock('../../../model-providers/index.js', () => ({
      // claude has a host key; codex does not.
      getModelProvider: (name: string) => ({
        getAuth: () => (name === 'claude' ? { name: 'x-api-key', value: 'k' } : null),
      }),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo');
    expect(result.status).toBe(200);
    const body = result.body as { providerAuth: Record<string, boolean> };
    expect(body.providerAuth).toEqual({ claude: true, codex: false, local: true });
    vi.unstubAllGlobals();
  });

  it('PUT replaces the whitelist', async () => {
    let written: unknown;
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: (_id: string, column: string, value: unknown) => {
        if (column === 'allowed_models') written = value;
      },
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all' }),
    }));
    const { handlePutModels } = await import('./models.js');
    const result = handlePutModels('draft_demo', {
      allowedModels: [{ provider: 'codex', model: 'gpt-5-mini' }],
    });
    expect(result.status).toBe(200);
    expect(written).toEqual([{ provider: 'codex', model: 'gpt-5-mini' }]);
  });

  it('PUT rejects non-array body', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: () => {},
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    const { handlePutModels } = await import('./models.js');
    expect(handlePutModels('draft_demo', { allowedModels: 'oops' as unknown as never }).status).toBe(400);
  });

  it('PUT rejects entries missing provider or model', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: () => {},
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    const { handlePutModels } = await import('./models.js');
    expect(handlePutModels('draft_demo', { allowedModels: [{ provider: 'claude' } as unknown as never] }).status).toBe(
      400,
    );
  });

  it('PUT /active-model persists model to DB (not just container.json)', async () => {
    const setModelCalls: { folder: string; model: string | null }[] = [];
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({ id: 'ag-demo', folder: 'draft_demo', name: 'Demo', agent_provider: null, created_at: '' }),
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ provider: 'local' }),
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
