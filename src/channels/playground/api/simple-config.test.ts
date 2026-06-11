import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TMP = '/tmp/nanoclaw-test-simple-config';
const SKILLS = path.join(TMP, 'container', 'skills');

// CONTAINER_DIR is read at module load by simple-config.ts, so the config
// mock must be in place before the dynamic import in each test.
vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, CONTAINER_DIR: path.join('/tmp/nanoclaw-test-simple-config', 'container') };
});

function writeSkill(name: string, md: string | null) {
  const dir = path.join(SKILLS, name);
  fs.mkdirSync(dir, { recursive: true });
  if (md !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
}

const GROUP = { id: 'ag-1', folder: 'user_01', name: 'Pilot User 1', agent_provider: null, created_at: '' };

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SKILLS, { recursive: true });
  writeSkill(
    'image-gen',
    '---\ndescription: Create pictures, logos, and illustrations. Saves them as files.\n---\n# Image gen\n',
  );
  writeSkill('pdf-reader', '# PDF Reader\nNo frontmatter here.\n');
  writeSkill('wiki', '---\ndescription: Browse and edit the course wiki\n---\n# Wiki\n');
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('handleGetSimpleConfig', () => {
  it('returns the template shortlist with descriptions, titles, and enabled state', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({
        skills: ['image-gen'],
        modelProvider: 'openai-codex',
        model: 'gpt-5.4-mini',
        assistantName: 'JaneBot',
      }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: ['image-gen', 'pdf-reader'], allowed_models: [] }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    expect(r.status).toBe(200);
    const body = r.body as {
      agentName: string;
      skills: { name: string; title: string; description: string; enabled: boolean }[];
    };
    expect(body.agentName).toBe('JaneBot');
    expect(body.skills).toEqual([
      {
        name: 'image-gen',
        title: 'Image gen',
        description: 'Create pictures, logos, and illustrations.',
        enabled: true,
      },
      {
        name: 'pdf-reader',
        title: 'Pdf reader',
        description: 'Pdf reader',
        enabled: false,
      },
    ]);
  });

  it("template skills 'all' (or missing slot) falls back to the full container skills dir", async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: 'all', model: 'gpt-5.4-mini', modelProvider: 'openai-codex' }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    expect(r.status).toBe(200);
    const body = r.body as { skills: { name: string; enabled: boolean }[] };
    expect(body.skills.map((s) => s.name)).toEqual(['image-gen', 'pdf-reader', 'wiki']);
    // agent has skills:'all' → everything reads enabled
    expect(body.skills.every((s) => s.enabled)).toBe(true);
  });

  it('resolves template allowed_models against the catalog; falls back to the active model when empty', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [], modelProvider: 'openai-codex', model: 'gpt-5.4-mini' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({
      getModelCatalog: () => [{ id: 'claude-haiku-4-5', modelProvider: 'anthropic', displayName: 'Claude Haiku 4.5' }],
    }));

    // a) template has two models — one in catalog (display name), one not (id fallback)
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({
        skills: [],
        allowed_models: [
          { provider: 'anthropic', model: 'claude-haiku-4-5' },
          { provider: 'local', model: 'Qwen3.6-35B' },
        ],
      }),
    }));
    let mod = await import('./simple-config.js');
    let r = mod.handleGetSimpleConfig('user_01');
    let body = r.body as { models: { provider: string; id: string; displayName: string }[]; activeModel: unknown };
    expect(body.models).toEqual([
      { provider: 'anthropic', id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
      { provider: 'local', id: 'Qwen3.6-35B', displayName: 'Qwen3.6-35B' },
    ]);
    expect(body.activeModel).toEqual({ provider: 'openai-codex', id: 'gpt-5.4-mini' });

    // b) empty template list → the agent's current model is the only entry
    vi.resetModules();
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [], modelProvider: 'openai-codex', model: 'gpt-5.4-mini' }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: [], allowed_models: [] }),
    }));
    mod = await import('./simple-config.js');
    r = mod.handleGetSimpleConfig('user_01');
    body = r.body as typeof body;
    expect(body.models).toEqual([{ provider: 'openai-codex', id: 'gpt-5.4-mini', displayName: 'gpt-5.4-mini' }]);
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => undefined }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: () => ({ skills: [] }) }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    expect(handleGetSimpleConfig('nope').status).toBe(404);
  });

  it('falls back to the humanized name for YAML block-scalar descriptions', async () => {
    writeSkill('onecli-gateway', '---\ndescription: >-\n  Long text here.\n---\n# OneCLI\n');
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [] }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: ['onecli-gateway'], allowed_models: [] }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    const body = r.body as { skills: { description: string }[] };
    expect(body.skills[0]!.description).toBe('Onecli gateway');
  });

  it('returns models: [] and activeModel: null for a group with no model configured', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({ getAgentGroupByFolder: () => GROUP }));
    vi.doMock('../../../container-config.js', () => ({
      materializeContainerJson: () => ({ skills: [] }),
    }));
    vi.doMock('../../../default-participant-slot.js', () => ({
      readSlotConfig: () => ({ skills: [], allowed_models: [] }),
    }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleGetSimpleConfig } = await import('./simple-config.js');
    const r = handleGetSimpleConfig('user_01');
    const body = r.body as { models: unknown[]; activeModel: unknown };
    expect(body.models).toEqual([]);
    expect(body.activeModel).toBeNull();
  });
});

describe('humanizeSkillTitle', () => {
  it('kebab → spaced, first letter capitalized', async () => {
    const { humanizeSkillTitle } = await import('./simple-config.js');
    expect(humanizeSkillTitle('image-gen')).toBe('Image gen');
    expect(humanizeSkillTitle('rag-pdf-ingest')).toBe('Rag pdf ingest');
    expect(humanizeSkillTitle('wiki')).toBe('Wiki');
  });
});

describe('handlePutAgentName', () => {
  function mockWriteDeps() {
    const updateScalars = vi.fn();
    const updateGroup = vi.fn();
    const materialize = vi.fn(() => ({ skills: [] }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => GROUP,
      updateAgentGroup: updateGroup,
    }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: updateScalars }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: materialize }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    return { updateScalars, updateGroup, materialize };
  }

  it('writes assistant_name + group display name and re-materializes container.json', async () => {
    const { updateScalars, updateGroup, materialize } = mockWriteDeps();
    const { handlePutAgentName } = await import('./simple-config.js');
    const r = handlePutAgentName('user_01', { name: '  JaneBot  ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, name: 'JaneBot' });
    expect(updateScalars).toHaveBeenCalledWith('ag-1', { assistant_name: 'JaneBot' });
    expect(updateGroup).toHaveBeenCalledWith('ag-1', { name: 'JaneBot' });
    expect(materialize).toHaveBeenCalledWith('ag-1');
  });

  it('400s on empty, whitespace-only, too-long, or non-string names', async () => {
    mockWriteDeps();
    const { handlePutAgentName } = await import('./simple-config.js');
    expect(handlePutAgentName('user_01', { name: '' }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: '   ' }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: 'x'.repeat(41) }).status).toBe(400);
    expect(handlePutAgentName('user_01', { name: 42 }).status).toBe(400);
    expect(handlePutAgentName('user_01', {}).status).toBe(400);
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => undefined,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handlePutAgentName } = await import('./simple-config.js');
    expect(handlePutAgentName('nope', { name: 'X' }).status).toBe(404);
  });
});

describe('handleSimpleRestart', () => {
  it('kills the group container and reports ok', async () => {
    const kill = vi.fn();
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => GROUP,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('./agent-library-handlers.js', () => ({ killGroupContainer: kill }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleSimpleRestart } = await import('./simple-config.js');
    const r = handleSimpleRestart('user_01');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith('user_01', 'simple tab save');
  });

  it('404s on an unknown folder', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getAgentGroupByFolder: () => undefined,
      updateAgentGroup: vi.fn(),
    }));
    vi.doMock('./agent-library-handlers.js', () => ({ killGroupContainer: vi.fn() }));
    vi.doMock('../../../db/container-configs.js', () => ({ updateContainerConfigScalars: vi.fn() }));
    vi.doMock('../../../container-config.js', () => ({ materializeContainerJson: vi.fn() }));
    vi.doMock('../../../default-participant-slot.js', () => ({ readSlotConfig: () => null }));
    vi.doMock('../../../model-catalog.js', () => ({ getModelCatalog: () => [] }));
    const { handleSimpleRestart } = await import('./simple-config.js');
    expect(handleSimpleRestart('nope').status).toBe(404);
  });
});
