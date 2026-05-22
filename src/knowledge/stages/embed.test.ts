import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embedChunks } from './embed.js';
import type { Chunk } from '../types.js';

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c:${i}`,
    corpusId: 'c',
    source: 'f.txt',
    text: `chunk text ${i}`,
    index: i,
  }));
}

function mockEmbeddingResponse(n: number, dims = 4): object {
  return {
    object: 'list',
    data: Array.from({ length: n }, (_, i) => ({
      object: 'embedding',
      index: i,
      embedding: Array.from({ length: dims }, () => Math.random()),
    })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: n * 10, total_tokens: n * 10 },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('embedChunks', () => {
  it('calls /openai/v1/embeddings with correct body and returns a map', async () => {
    const chunks = makeChunks(3);
    const mockResponse = mockEmbeddingResponse(3, 4);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }),
    );

    const result = await embedChunks(chunks, 'http://localhost:3001', 3);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3001/openai/v1/embeddings');
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(chunks.map((c) => c.text));

    expect(result.size).toBe(3);
    for (const chunk of chunks) {
      expect(result.has(chunk.id)).toBe(true);
      expect(result.get(chunk.id)).toBeInstanceOf(Float32Array);
      expect(result.get(chunk.id)!.length).toBe(4);
    }
  });

  it('batches chunks when count exceeds batchSize', async () => {
    const chunks = makeChunks(5);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => mockEmbeddingResponse(3, 4) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockEmbeddingResponse(2, 4) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedChunks(chunks, 'http://localhost:3001', 5, 3);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(5);
  });

  it('throws when the API returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    await expect(embedChunks(makeChunks(1), 'http://localhost:3001')).rejects.toThrow(/embeddings API error.*401/);
  });

  it('returns empty map for empty input without calling fetch', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await embedChunks([], 'http://localhost:3001');
    expect(result.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
