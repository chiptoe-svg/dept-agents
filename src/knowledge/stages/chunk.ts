import type { Chunk } from '../types.js';

const CHARS_PER_TOKEN = 4;

/** Fixed-size chunker with character-approximated token count and overlap. */
export function chunkFixed(
  text: string,
  corpusId: string,
  source: string,
  targetTokens = 512,
  overlapTokens = 64,
): Chunk[] {
  const chunkSize = targetTokens * CHARS_PER_TOKEN;
  const overlapSize = overlapTokens * CHARS_PER_TOKEN;
  if (text.length <= chunkSize) {
    return [{ id: `${corpusId}:0`, corpusId, source, text, index: 0 }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push({
      id: `${corpusId}:${index}`,
      corpusId,
      source,
      text: text.slice(start, end),
      index,
    });
    index++;
    start += chunkSize - overlapSize;
    if (start >= text.length) break;
  }
  return chunks;
}

const SENTENCE_RE = /[^.!?]+[.!?]+/g;

/** Sentence-boundary chunker: groups sentences into chunks of at most maxSentencesPerChunk. */
export function chunkSentence(text: string, corpusId: string, source: string, maxSentencesPerChunk = 8): Chunk[] {
  const sentences = text.match(SENTENCE_RE) ?? [text];
  const chunks: Chunk[] = [];
  let index = 0;
  for (let i = 0; i < sentences.length; i += maxSentencesPerChunk) {
    const group = sentences
      .slice(i, i + maxSentencesPerChunk)
      .join('')
      .trim();
    if (!group) continue;
    chunks.push({ id: `${corpusId}:${index}`, corpusId, source, text: group, index });
    index++;
  }
  return chunks.length ? chunks : [{ id: `${corpusId}:0`, corpusId, source, text, index: 0 }];
}
