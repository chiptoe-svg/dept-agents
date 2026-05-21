import type { Chunk } from '../types.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_BATCH_SIZE = 100;

/**
 * Call the OpenAI embeddings API (via the credential proxy) for all chunks.
 * Returns a map from chunk.id to the embedding Float32Array.
 *
 * @param proxyBaseUrl  e.g. 'http://localhost:3001'. The endpoint called is
 *                      `{proxyBaseUrl}/openai/v1/embeddings`.
 * @param _dims         Ignored at runtime; used only in tests to verify shape.
 * @param batchSize     Max inputs per API call (default 100; API max is 2048).
 */
export async function embedChunks(
  chunks: Chunk[],
  proxyBaseUrl: string,
  _dims?: number,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<Map<string, Float32Array>> {
  const result = new Map<string, Float32Array>();
  if (chunks.length === 0) return result;

  const url = `${proxyBaseUrl.replace(/\/$/, '')}/openai/v1/embeddings`;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch.map((c) => c.text),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embeddings API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    for (const item of data.data) {
      const chunk = batch[item.index];
      result.set(chunk.id, new Float32Array(item.embedding));
    }
  }

  return result;
}
