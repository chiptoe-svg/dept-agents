import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseTurnRows, toolInvoked, answerGrounded, matchesExpected } from './bench-mcp-score.js';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, 'bench-fixtures/mcp-turn.json'), 'utf8'));

describe('bench-mcp-score', () => {
  it('extracts the reply and the tool call + result from real trace rows', () => {
    const t = parseTurnRows(rows);
    expect(t.reply.length).toBeGreaterThan(0);
    expect(t.errored).toBe(false);
    const call = t.toolCalls.find((c) => c.name.includes('search-clemson-classes'));
    expect(call).toBeTruthy();
    expect(call!.resultText).toContain('202608'); // tool result carried through
  });
  it('toolInvoked matches expected tool-name substring', () => {
    const t = parseTurnRows(rows);
    expect(toolInvoked(t, 'search-clemson-classes')).toBe(true);
    expect(toolInvoked(t, 'get-clemson-room-availability')).toBe(false);
    // `|`-alternation: matches if ANY alternative matches a tool name.
    expect(toolInvoked(t, 'get-clemson-section-details|search-clemson-classes')).toBe(true);
    expect(toolInvoked(t, 'room-availability|section-details')).toBe(false);
  });
  it('answerGrounded is true when reply shares a value with a tool result', () => {
    expect(answerGrounded(parseTurnRows(rows))).toBe(true);
  });
  it('answerGrounded is false when nothing overlaps', () => {
    const t = { reply: 'zzz nothing here', toolCalls: [{ name: 'x', resultText: '202608 Fall' }], errored: false };
    expect(answerGrounded(t)).toBe(false);
  });
  it('matchesExpected handles general-task checks', () => {
    expect(matchesExpected('{"answer": 42}', /\{\s*"answer"\s*:\s*42\s*\}/)).toBe(true);
    expect(matchesExpected('Alice', 'Alice')).toBe(true);
    expect(matchesExpected('Bob', 'Alice')).toBe(false);
  });
});
