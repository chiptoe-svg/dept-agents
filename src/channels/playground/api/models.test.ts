import { afterEach, describe, expect, it, vi } from 'vitest';

describe('models API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('GET returns catalog + current whitelist + discovered models (modelProvider shape)', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-haiku-4-5', modelProvider: 'anthropic' }],
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
        getAuth: () => (name === 'anthropic' ? { name: 'x-api-key', value: 'k' } : null),
      }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo');
    expect(result.status).toBe(200);
    const body = result.body as { catalog: unknown[]; allowedModels: unknown[]; discovered: unknown[] };
    expect(body.catalog).toHaveLength(1);
    expect(body.allowedModels).toHaveLength(1);
    // claude-opus is not in the catalog (which has `anthropic:claude-haiku-4-5`),
    // so it should appear in discovered as { modelProvider: 'anthropic', id: 'claude-opus' }.
    expect(body.discovered).toHaveLength(1);
    const discovered = body.discovered as { modelProvider: string; id: string }[];
    expect(discovered[0]).toEqual({ modelProvider: 'anthropic', id: 'claude-opus' });
  });

  it('GET activeModel uses modelProvider from container config', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-sonnet-4-6', modelProvider: 'anthropic' }],
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({
        skills: 'all',
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
    }));
    vi.doMock('../../../model-discovery.js', () => ({
      listAllForProvider: vi.fn(async () => []),
    }));
    vi.doMock('../../../model-providers/index.js', () => ({
      getModelProvider: () => ({ getAuth: () => ({ name: 'x-api-key', value: 'k' }) }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo');
    expect(result.status).toBe(200);
    const body = result.body as { activeModel: { modelProvider: string; model: string } | null };
    expect(body.activeModel).toEqual({ modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('GET reports per-provider auth: cloud via getAuth, local via reachability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [
        { id: 'claude-haiku-4-5', modelProvider: 'anthropic' },
        { id: 'gpt-5-mini', modelProvider: 'openai-codex' },
        { id: 'Qwen3.6-35B', modelProvider: 'local' },
      ],
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all' }),
    }));
    vi.doMock('../../../model-discovery.js', () => ({
      listAllForProvider: vi.fn(async () => []),
    }));
    vi.doMock('../../../model-providers/index.js', () => ({
      // anthropic has a host key; openai-codex does not.
      getModelProvider: (name: string) => ({
        getAuth: () => (name === 'anthropic' ? { name: 'x-api-key', value: 'k' } : null),
      }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo');
    expect(result.status).toBe(200);
    const body = result.body as { providerAuth: Record<string, boolean> };
    expect(body.providerAuth).toEqual({ anthropic: true, 'openai-codex': false, local: true });
    vi.unstubAllGlobals();
  });

  it('PUT replaces the whitelist', async () => {
    let written: unknown;
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: (_id: string, column: string, value: unknown) => {
        if (column === 'allowed_models') written = value;
      },
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all' }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handlePutModels } = await import('./models.js');
    const result = handlePutModels('draft_demo', {
      allowedModels: [{ provider: 'openai-codex', model: 'gpt-5-mini' }],
    });
    expect(result.status).toBe(200);
    expect(written).toEqual([{ provider: 'openai-codex', model: 'gpt-5-mini' }]);
  });

  it('PUT rejects non-array body', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: () => {},
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handlePutModels } = await import('./models.js');
    expect(handlePutModels('draft_demo', { allowedModels: 'oops' as unknown as never }).status).toBe(400);
  });

  it('PUT rejects entries missing provider or model', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({
      updateContainerConfigJson: () => {},
    }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handlePutModels } = await import('./models.js');
    expect(
      handlePutModels('draft_demo', { allowedModels: [{ provider: 'anthropic' } as unknown as never] }).status,
    ).toBe(400);
  });

  it('PUT /active-model accepts modelProvider+model and calls setModelProviderAndModel', async () => {
    const calls: { agentGroupId: string; opts: unknown }[] = [];
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: async (agentGroupId: string, opts: unknown) => {
        calls.push({ agentGroupId, opts });
      },
    }));
    const { handlePutActiveModel } = await import('./models.js');
    const result = await handlePutActiveModel('draft_demo', { modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      { agentGroupId: 'ag-demo', opts: { modelProvider: 'anthropic', model: 'claude-sonnet-4-6' } },
    ]);
    const body = result.body as { ok: true; activeModel: { modelProvider: string; model: string } };
    expect(body.activeModel).toEqual({ modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('PUT /active-model rejects missing modelProvider', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => ({
        id: 'ag-demo',
        folder: 'draft_demo',
        name: 'Demo',
        agent_provider: null,
        created_at: '',
      }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handlePutActiveModel } = await import('./models.js');
    const result = await handlePutActiveModel('draft_demo', { model: 'claude-sonnet-4-6' });
    expect(result.status).toBe(400);
    const body = result.body as { error: string };
    expect(body.error).toMatch(/modelProvider/);
  });
});
