import { afterEach, describe, expect, it, vi } from 'vitest';

describe('library API', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('GET /api/library returns all three tiers', async () => {
    vi.doMock('../../../library/storage.js', () => ({
      listAllTiers: () => ({
        default: [{ name: 'cw', description: 'd', persona: 'p' }],
        class: [],
        my: [],
      }),
    }));
    const { handleListLibrary } = await import('./library.js');
    const r = handleListLibrary('telegram:42');
    expect(r.status).toBe(200);
    const body = r.body as { default: unknown[]; class: unknown[]; my: unknown[] };
    expect(body.default).toHaveLength(1);
  });

  it('GET /api/library/:tier/:name returns the entry', async () => {
    vi.doMock('../../../library/storage.js', () => ({
      readEntry: (_t: unknown, n: string) => (n === 'cw' ? { name: 'cw', description: 'd', persona: 'p' } : undefined),
    }));
    const { handleGetEntry } = await import('./library.js');
    expect(handleGetEntry('default', 'cw', 'telegram:42').status).toBe(200);
    expect(handleGetEntry('default', 'nope', 'telegram:42').status).toBe(404);
  });

  it('GET /api/library/:tier/:name rejects unknown tier', async () => {
    vi.doMock('../../../library/storage.js', () => ({
      readEntry: () => undefined,
    }));
    const { handleGetEntry } = await import('./library.js');
    expect(handleGetEntry('bogus', 'cw', 'telegram:42').status).toBe(400);
  });

  it('POST /api/library/my/:name writes to My library and sanitizes the userId', async () => {
    let receivedStudentId: string | undefined;
    let written: { name: string } | undefined;
    vi.doMock('../../../library/storage.js', () => ({
      writeMyEntry: (id: string, _n: string, e: { name: string }) => {
        receivedStudentId = id;
        written = e;
      },
    }));
    const { handleSaveMyEntry } = await import('./library.js');
    const r = handleSaveMyEntry('telegram:42', 'baseline', {
      name: 'baseline',
      description: 'mine',
      persona: 'body',
    });
    expect(r.status).toBe(200);
    expect(receivedStudentId).toBe('telegram__42'); // colons sanitized
    expect(written?.name).toBe('baseline');
  });

  it('POST rejects body without persona string', async () => {
    vi.doMock('../../../library/storage.js', () => ({
      writeMyEntry: () => {},
    }));
    const { handleSaveMyEntry } = await import('./library.js');
    const r = handleSaveMyEntry('telegram:42', 'x', { name: 'x', description: 'd' } as unknown as never);
    expect(r.status).toBe(400);
  });
});
