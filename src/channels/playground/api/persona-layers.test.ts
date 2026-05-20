import { afterEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/drafts/:folder/persona-layers', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns the four-layer struct as JSON', async () => {
    const layers = { myPersona: 'A', groupBase: 'B', containerBase: 'C', global: 'D' };
    vi.doMock('../../../persona-layers.js', () => ({
      getEffectivePersonaLayers: () => layers,
    }));
    const { handlePersonaLayers } = await import('./persona-layers.js');
    const result = handlePersonaLayers('draft_demo');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(layers);
  });

  it('returns 500 + error body when getEffectivePersonaLayers throws', async () => {
    vi.doMock('../../../persona-layers.js', () => ({
      getEffectivePersonaLayers: () => {
        throw new Error('boom');
      },
    }));
    const { handlePersonaLayers } = await import('./persona-layers.js');
    const result = handlePersonaLayers('draft_demo');
    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toBe('boom');
  });
});
