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
    vi.doMock('./models-tab-state.js', () => ({
      computeProviderAvailability: async () => ({ anthropic: true }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo', 'user-1');
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
    vi.doMock('./models-tab-state.js', () => ({
      computeProviderAvailability: async () => ({ anthropic: true }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo', 'user-1');
    expect(result.status).toBe(200);
    const body = result.body as { activeModel: { modelProvider: string; model: string } | null };
    expect(body.activeModel).toEqual({ modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('GET surfaces providerAuth from computeProviderAvailability', async () => {
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
    // computeProviderAvailability returns availability keyed by SPEC id
    // (claude / codex / openai-platform / omlx / clemson). handleGetModels
    // translates those into modelProvider keys (anthropic / openai-codex /
    // … / local / clemson) so the chat-tab dropdown filter can look up
    // by the same string the catalog uses.
    vi.doMock('./models-tab-state.js', () => ({
      computeProviderAvailability: async () => ({
        claude: true,
        codex: false,
        omlx: true,
        // openai-platform + clemson omitted → translation reports false
      }),
    }));
    vi.doMock('../../../model-provider-switch.js', () => ({
      setModelProviderAndModel: vi.fn(async () => {}),
    }));
    const { handleGetModels } = await import('./models.js');
    const result = await handleGetModels('draft_demo', 'user-1');
    expect(result.status).toBe(200);
    const body = result.body as { providerAuth: Record<string, boolean> };
    // Post-C-5: keyed by group id, OR across member specs.
    //   openai    = codex(false) || openai-platform(missing) → false
    //   anthropic = claude(true)                              → true
    //   local     = omlx(true)                                → true
    //   clemson   = clemson(missing)                          → false
    expect(body.providerAuth).toEqual({
      openai: false,
      anthropic: true,
      local: true,
      clemson: false,
    });
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
    // 'anthropic' is BOTH a group id and the catalog modelProvider name —
    // the resolver finds it as a group, sees user-1 has claude apiKey, and
    // resolves to the same 'anthropic' string. End-state is unchanged.
    vi.doMock('../../../student-provider-auth.js', () => ({
      loadStudentProviderCreds: (userId: string, specId: string) =>
        userId === 'user-1' && specId === 'claude' ? { apiKey: { value: 'sk-ant-fake' }, active: 'apiKey' } : null,
    }));
    vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
      getOwnerUserId: () => null,
    }));
    const { handlePutActiveModel } = await import('./models.js');
    const result = await handlePutActiveModel('draft_demo', 'user-1', {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      { agentGroupId: 'ag-demo', opts: { modelProvider: 'anthropic', model: 'claude-sonnet-4-6' } },
    ]);
    const body = result.body as { ok: true; activeModel: { modelProvider: string; model: string } };
    expect(body.activeModel).toEqual({ modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('PUT /active-model resolves group id (openai) to a concrete spec when user has creds', async () => {
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
    // user-1 has codex creds (e.g. ChatGPT OAuth pasted).
    vi.doMock('../../../student-provider-auth.js', () => ({
      loadStudentProviderCreds: (userId: string, specId: string) => {
        if (userId === 'user-1' && specId === 'codex') {
          return {
            apiKey: undefined,
            oauth: { accessToken: 'sk-fake', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 },
            active: 'oauth',
          };
        }
        return null;
      },
    }));
    vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
      getOwnerUserId: () => null,
    }));

    const { handlePutActiveModel } = await import('./models.js');
    const result = await handlePutActiveModel('draft_demo', 'user-1', { modelProvider: 'openai', model: 'gpt-5.5' });
    expect(result.status).toBe(200);
    // Group 'openai' should resolve to the modelProvider name 'openai-codex'
    // because user-1 has codex creds and openai-codex comes first in the
    // group's member list.
    expect(calls).toEqual([{ agentGroupId: 'ag-demo', opts: { modelProvider: 'openai-codex', model: 'gpt-5.5' } }]);
  });

  it('PUT /active-model rejects a group selection when nobody has creds', async () => {
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
    vi.doMock('../../../student-provider-auth.js', () => ({
      loadStudentProviderCreds: () => null,
    }));
    vi.doMock('../../../modules/permissions/db/user-roles.js', () => ({
      getOwnerUserId: () => null,
    }));
    const { handlePutActiveModel } = await import('./models.js');
    const result = await handlePutActiveModel('draft_demo', 'user-1', {
      modelProvider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    expect(result.status).toBe(400);
    const body = result.body as { error: string };
    expect(body.error).toMatch(/No usable Anthropic credential/);
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
    const result = await handlePutActiveModel('draft_demo', 'user-1', { model: 'claude-sonnet-4-6' });
    expect(result.status).toBe(400);
    const body = result.body as { error: string };
    expect(body.error).toMatch(/modelProvider/);
  });
});
