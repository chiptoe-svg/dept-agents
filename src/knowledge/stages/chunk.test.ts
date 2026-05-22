import { describe, it, expect } from 'vitest';
import { chunkFixed, chunkSentence } from './chunk.js';

describe('chunkFixed', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkFixed('hello world', 'c1', 'test.txt');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello world');
    expect(chunks[0].corpusId).toBe('c1');
    expect(chunks[0].source).toBe('test.txt');
  });

  it('splits long text into overlapping chunks', () => {
    // 512 tokens * 4 chars = 2048 chars per chunk. Make text ~3x that.
    const text = 'word '.repeat(1500); // 7500 chars ≈ 1875 tokens
    const chunks = chunkFixed(text, 'c1', 'big.txt', 512, 64);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: last two chunks share words
    const second = chunks[chunks.length - 2].text;
    const last = chunks[chunks.length - 1].text;
    const secondWords = second.split(' ');
    const lastWords = last.split(' ');
    const overlap = secondWords.filter((w) => lastWords.includes(w));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('assigns sequential ids', () => {
    const text = 'word '.repeat(600);
    const chunks = chunkFixed(text, 'c1', 'f.txt', 512, 0);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
      expect(chunks[i].id).toBe(`c1:${i}`);
    }
  });
});

describe('chunkSentence', () => {
  it('groups sentences into chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1}.`).join(' ');
    const chunks = chunkSentence(text, 'c1', 'test.txt', 8);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk has at most 8 sentence-ending punctuation marks
    for (const chunk of chunks) {
      const count = (chunk.text.match(/\./g) ?? []).length;
      expect(count).toBeLessThanOrEqual(8);
    }
  });

  it('handles single sentence', () => {
    const chunks = chunkSentence('Just one.', 'c1', 'f.txt', 8);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Just one.');
  });
});
