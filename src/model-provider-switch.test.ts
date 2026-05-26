import { afterEach, describe, expect, it, vi } from 'vitest';

describe('setModelProviderAndModel', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('writes to DB, materializes config, and kills running containers', async () => {
    const dbCalls: { agentGroupId: string; updates: unknown }[] = [];
    const materializedFor: string[] = [];
    const killedSessions: string[] = [];

    vi.doMock('./db/container-configs.js', () => ({
      updateContainerConfigScalars: (agentGroupId: string, updates: unknown) => {
        dbCalls.push({ agentGroupId, updates });
      },
    }));
    vi.doMock('./container-config.js', () => ({
      materializeContainerJson: (agentGroupId: string) => {
        materializedFor.push(agentGroupId);
        return {};
      },
    }));
    vi.doMock('./db/sessions.js', () => ({
      getActiveSessions: () => [
        { id: 'sess-1', agent_group_id: 'ag-123' },
        { id: 'sess-2', agent_group_id: 'ag-other' }, // different group — should not be killed
      ],
    }));
    vi.doMock('./container-runner.js', () => ({
      isContainerRunning: (sessionId: string) => sessionId === 'sess-1',
      killContainer: (sessionId: string) => {
        killedSessions.push(sessionId);
      },
    }));

    const { setModelProviderAndModel } = await import('./model-provider-switch.js');
    await setModelProviderAndModel('ag-123', { modelProvider: 'anthropic', model: 'claude-sonnet-4-6' });

    expect(dbCalls).toEqual([
      { agentGroupId: 'ag-123', updates: { model_provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    ]);
    expect(materializedFor).toEqual(['ag-123']);
    // Only sess-1 is running and belongs to ag-123.
    expect(killedSessions).toEqual(['sess-1']);
  });

  it('skips kill for sessions belonging to other agent groups', async () => {
    const killedSessions: string[] = [];

    vi.doMock('./db/container-configs.js', () => ({
      updateContainerConfigScalars: () => {},
    }));
    vi.doMock('./container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    vi.doMock('./db/sessions.js', () => ({
      getActiveSessions: () => [{ id: 'sess-x', agent_group_id: 'ag-other' }],
    }));
    vi.doMock('./container-runner.js', () => ({
      isContainerRunning: () => true,
      killContainer: (sessionId: string) => {
        killedSessions.push(sessionId);
      },
    }));

    const { setModelProviderAndModel } = await import('./model-provider-switch.js');
    await setModelProviderAndModel('ag-mine', { modelProvider: 'local', model: 'Qwen3' });

    expect(killedSessions).toEqual([]);
  });

  it('is best-effort on kill errors — does not throw', async () => {
    vi.doMock('./db/container-configs.js', () => ({
      updateContainerConfigScalars: () => {},
    }));
    vi.doMock('./container-config.js', () => ({
      materializeContainerJson: () => ({}),
    }));
    vi.doMock('./db/sessions.js', () => ({
      getActiveSessions: () => [{ id: 'sess-err', agent_group_id: 'ag-123' }],
    }));
    vi.doMock('./container-runner.js', () => ({
      isContainerRunning: () => true,
      killContainer: () => {
        throw new Error('docker gone');
      },
    }));

    const { setModelProviderAndModel } = await import('./model-provider-switch.js');
    // Should not throw even though killContainer throws.
    await expect(
      setModelProviderAndModel('ag-123', { modelProvider: 'anthropic', model: 'any' }),
    ).resolves.toBeUndefined();
  });
});
