// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { previewForToolArgs, previewForToolResult, classifyToolResult, traceResultText } from './chat.js';

describe('traceResultText', () => {
  it('extracts text from a string, an AgentToolResult content array, and falls back to JSON', () => {
    expect(traceResultText('hello')).toBe('hello');
    expect(
      traceResultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a b');
    expect(traceResultText({ foo: 1 })).toContain('foo');
    expect(traceResultText(null)).toBe('');
  });
  it('handles bare text-block arrays and ignores non-string text values', () => {
    expect(
      traceResultText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a b');
    expect(traceResultText([{ text: 5 }])).toBe(JSON.stringify([{ text: 5 }]));
  });
});

describe('classifyToolResult', () => {
  it('prefers the native isError flag', () => {
    expect(classifyToolResult({ isError: true, result: 'whatever' })).toBe('error');
    expect(classifyToolResult({ isError: false, result: 'Fetch failed: x' })).toBe('ok');
  });
  it('falls back to error-string prefixes when isError is absent', () => {
    expect(classifyToolResult({ result: { content: [{ type: 'text', text: 'Fetch failed: HTTP 500' }] } })).toBe(
      'error',
    );
    expect(classifyToolResult({ result: 'blocked by egress policy: internal address 10.0.0.1' })).toBe('error');
    expect(classifyToolResult({ result: 'Web search failed: 422' })).toBe('error');
    expect(classifyToolResult({ result: 'Search results for "x": ...' })).toBe('ok');
  });
  it('returns ok for null/empty events', () => {
    expect(classifyToolResult(null)).toBe('ok');
    expect(classifyToolResult({})).toBe('ok');
  });
  it('does not false-positive on Error-free text (Fix 1)', () => {
    expect(classifyToolResult({ result: 'Error-free approaches to X' })).toBe('ok');
    expect(classifyToolResult({ result: 'Error: something broke' })).toBe('error');
  });
});

describe('previewForToolArgs', () => {
  it('surfaces the meaningful field per tool, defers to the generic formatter otherwise', () => {
    expect(previewForToolArgs('web_search', { query: 'weather in paris' })).toContain('weather in paris');
    expect(previewForToolArgs('fetch_url', { url: 'https://example.com/x' })).toContain('https://example.com/x');
    expect(previewForToolArgs('bash', { cmd: 'ls -la' })).toContain('ls -la');
    expect(previewForToolArgs('mystery', { query: 'q' })).toContain('q');
  });
  it('handles the real bash param name `command`', () => {
    expect(previewForToolArgs('bash', { command: 'ls -la' })).toContain('ls -la');
  });
});

describe('previewForToolResult', () => {
  it('shows the first error line when status is error', () => {
    expect(
      previewForToolResult('fetch_url', { content: [{ type: 'text', text: 'Fetch failed: HTTP 500\nmore' }] }, 'error'),
    ).toContain('Fetch failed: HTTP 500');
  });
  it('shows a result count for web_search successes when derivable', () => {
    const r = { content: [{ type: 'text', text: 'Search results for "x":\n\n1. A\n2. B\n3. C' }] };
    expect(previewForToolResult('web_search', r, 'ok')).toMatch(/\b3 results\b/);
  });
  it('falls back to the generic preview for unknown tools', () => {
    expect(previewForToolResult('mystery', 'plain text result', 'ok')).toContain('plain text');
  });
});

import { appendPiEvent } from './chat.js';

function freshTrace() {
  const ul = document.createElement('ul');
  const turnUl = document.createElement('ul');
  ul._currentTurnUl = turnUl;
  ul.appendChild(turnUl);
  return ul;
}
function pi(trace, event) {
  appendPiEvent(trace, event);
}

describe('unified tool card', () => {
  it('renders ONE card for a tool call + its execution, keyed by toolCallId', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 } });
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'tc1', name: 'web_search', arguments: { query: 'paris' } },
      },
    });
    pi(trace, { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'web_search', args: { query: 'paris' } });
    pi(trace, {
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      isError: false,
      result: { content: [{ type: 'text', text: 'Search results for "paris":\n\n1. A\n2. B' }] },
    });

    const cards = trace.querySelectorAll('[data-tool-call-id="tc1"]');
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.textContent).toContain('paris');
    expect(card.textContent).toMatch(/result/i);
  });

  it('keeps parallel tool calls in separate cards', () => {
    const trace = freshTrace();
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'tcA', name: 'fetch_url', arguments: { url: 'https://a' } },
      },
    });
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: { id: 'tcB', name: 'fetch_url', arguments: { url: 'https://b' } },
      },
    });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcA', isError: false, result: 'ok-a' });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcB', isError: false, result: 'ok-b' });
    expect(trace.querySelectorAll('[data-tool-call-id="tcA"]').length).toBe(1);
    expect(trace.querySelectorAll('[data-tool-call-id="tcB"]').length).toBe(1);
    // Fix 5: fallback-created cards must have name/args populated, not just exist.
    expect(trace.querySelector('[data-tool-call-id="tcA"]').textContent).toContain('https://a');
    expect(trace.querySelector('[data-tool-call-id="tcB"]').textContent).toContain('https://b');
  });

  it('renders exactly one card for a toolcall_end with no tc.id (no-id degenerate path)', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 } });
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { name: 'web_search', arguments: { query: 'q' } },
      },
    });
    // No exec events — the card stays in pendingToolCards (no id to key by).
    const cards = trace.querySelectorAll('.trace-tool_use');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('q');
  });

  it('renders a card when execution arrives with no preceding toolcall_end', () => {
    const trace = freshTrace();
    pi(trace, { type: 'tool_execution_start', toolCallId: 'tcX', toolName: 'web_search', args: { query: 'q' } });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'tcX', isError: false, result: 'done' });
    expect(trace.querySelectorAll('[data-tool-call-id="tcX"]').length).toBe(1);
  });
});

describe('status badge', () => {
  it('marks an errored execution with the error class + ✗', () => {
    const trace = freshTrace();
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'e1', name: 'fetch_url', arguments: { url: 'http://192.168.64.1' } },
      },
    });
    pi(trace, {
      type: 'tool_execution_end',
      toolCallId: 'e1',
      isError: true,
      result: { content: [{ type: 'text', text: 'Fetch failed: blocked by egress policy' }] },
    });
    const card = trace.querySelector('[data-tool-call-id="e1"]');
    expect(card.classList.contains('trace-tool-error')).toBe(true);
    expect(card.querySelector('.trace-tool-badge').textContent).toContain('✗');
  });
  it('marks a successful execution with the ok class + ✓', () => {
    const trace = freshTrace();
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'k1', name: 'web_search', arguments: { query: 'x' } },
      },
    });
    pi(trace, {
      type: 'tool_execution_end',
      toolCallId: 'k1',
      isError: false,
      result: 'Search results for "x":\n\n1. A',
    });
    const card = trace.querySelector('[data-tool-call-id="k1"]');
    expect(card.classList.contains('trace-tool-ok')).toBe(true);
    expect(card.querySelector('.trace-tool-badge').textContent).toContain('✓');
  });
  // This test exercises the exec-without-toolcall_end path: no toolcall_end fired,
  // so classifyToolResult relies on the error-string regex rather than isError.
  it('uses the error-string fallback when isError is absent', () => {
    const trace = freshTrace();
    pi(trace, { type: 'tool_execution_start', toolCallId: 'f1', toolName: 'web_search', args: {} });
    pi(trace, { type: 'tool_execution_end', toolCallId: 'f1', result: 'Web search failed: 422' });
    expect(trace.querySelector('[data-tool-call-id="f1"]').classList.contains('trace-tool-error')).toBe(true);
  });
  it('shows a pending badge with no status class before execution ends', () => {
    const trace = freshTrace();
    pi(trace, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'p1', name: 'web_search', arguments: { query: 'x' } },
      },
    });
    pi(trace, { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'web_search', args: { query: 'x' } });
    const card = trace.querySelector('[data-tool-call-id="p1"]');
    expect(card.classList.contains('trace-tool-ok')).toBe(false);
    expect(card.classList.contains('trace-tool-error')).toBe(false);
    expect(card.querySelector('.trace-tool-badge').textContent).toBe('…');
  });
});

describe('no regression: text-only turn', () => {
  it('renders the assistant bubble for a plain message turn', () => {
    const trace = freshTrace();
    pi(trace, { type: 'message_start', message: { role: 'assistant' } });
    pi(trace, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' } });
    pi(trace, { type: 'message_end', message: { usage: { input: 10, output: 3, cost: { total: 0.0001 } } } });
    expect(trace.textContent).toContain('Hello world');
  });
});
