import Database from 'better-sqlite3';

export type ToolCall = { name: string; resultText: string };
export type TurnResult = { reply: string; toolCalls: ToolCall[]; errored: boolean };
export type OutboundRow = { kind: string; content: string };

export function parseTurnRows(rows: OutboundRow[]): TurnResult {
  let reply = '';
  const callsById = new Map<string, ToolCall>();

  for (const row of rows) {
    if (row.kind === 'chat') {
      const parsed = JSON.parse(row.content);
      reply = parsed.text;
    } else if (row.kind === 'trace') {
      const parsed = JSON.parse(row.content);
      if (parsed.type !== 'pi_event') continue;
      const event = parsed.event;
      if (event.type === 'tool_execution_start') {
        callsById.set(event.toolCallId, { name: event.toolName, resultText: '' });
      } else if (event.type === 'tool_execution_end') {
        const call = callsById.get(event.toolCallId);
        if (call) {
          const contentItems = event.result?.content ?? [];
          call.resultText = contentItems.map((c: { text: string }) => c.text).join('');
        }
      }
    }
  }

  return {
    reply,
    toolCalls: Array.from(callsById.values()),
    errored: reply.length === 0,
  };
}

export function readTurnOutbound(outboundPath: string, sinceSeq: number): TurnResult {
  const db = new Database(outboundPath, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT seq, kind, content FROM messages_out WHERE seq > @sinceSeq ORDER BY seq')
      .all({ sinceSeq }) as OutboundRow[];
    return parseTurnRows(rows);
  } finally {
    db.close();
  }
}

/**
 * True if the turn invoked a matching tool. `expectedTool` may be a single
 * substring or a `|`-separated set of acceptable substrings (e.g. when more
 * than one tool legitimately answers the question — `search-clemson-classes`
 * also returns section meeting details). Any alternative matching any tool
 * name counts.
 */
export function toolInvoked(t: TurnResult, expectedTool: string): boolean {
  const alternatives = expectedTool.split('|').map((s) => s.trim()).filter(Boolean);
  return t.toolCalls.some((c) => alternatives.some((alt) => c.name.includes(alt)));
}

export function answerGrounded(t: TurnResult): boolean {
  const tokens = t.reply.match(/[A-Za-z0-9]{3,}/g) ?? [];
  return tokens.some((token) => {
    const lower = token.toLowerCase();
    return t.toolCalls.some((c) => c.resultText.toLowerCase().includes(lower));
  });
}

export function matchesExpected(reply: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) return expected.test(reply);
  return reply.includes(expected);
}
