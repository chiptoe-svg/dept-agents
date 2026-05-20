/**
 * Programmatic gate functions for bench request evaluation.
 *
 * Each gate takes the output text (or array of per-turn texts for multi)
 * and the `expected` value from bench-prompts.json, returning true if the
 * output passes the gate.
 *
 * Gates:
 *   equals           — output.trim() === expected (string)
 *   regex            — RegExp(expected).test(output)
 *   contains         — output.toLowerCase().includes(expected.toLowerCase())
 *   contains-all     — all strings in expected[] appear in output
 *   min-bullets-per-turn — each turn in output[] has >= expected bullet lines
 */

export type GateName = 'equals' | 'regex' | 'contains' | 'contains-all' | 'min-bullets-per-turn';

type GateFn = (output: string | string[], expected: unknown) => boolean;

function countBullets(text: string): number {
  // Count lines starting with -, *, •, or a numbered list item like "1."
  return text
    .split('\n')
    .filter((line) => /^\s*[-*•]/.test(line) || /^\s*\d+[.)]\s/.test(line)).length;
}

export const gates: Record<GateName, GateFn> = {
  equals(output, expected) {
    const text = typeof output === 'string' ? output : output.join('\n');
    return text.trim() === String(expected);
  },

  regex(output, expected) {
    const text = typeof output === 'string' ? output : output.join('\n');
    try {
      return new RegExp(String(expected)).test(text);
    } catch {
      return false;
    }
  },

  contains(output, expected) {
    const text = typeof output === 'string' ? output : output.join('\n');
    return text.toLowerCase().includes(String(expected).toLowerCase());
  },

  'contains-all'(output, expected) {
    const text = typeof output === 'string' ? output : output.join('\n');
    if (!Array.isArray(expected)) return false;
    return (expected as string[]).every((e) => text.toLowerCase().includes(String(e).toLowerCase()));
  },

  'min-bullets-per-turn'(output, expected) {
    const turns = Array.isArray(output) ? output : [output];
    const min = typeof expected === 'number' ? expected : Number(expected);
    return turns.every((turn) => countBullets(turn) >= min);
  },
};

export function runGate(
  gateName: string,
  output: string | string[],
  expected: unknown,
): boolean {
  const fn = gates[gateName as GateName];
  if (!fn) {
    console.warn(`[bench-gates] Unknown gate: ${gateName}`);
    return false;
  }
  return fn(output, expected);
}
