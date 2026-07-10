import { describe, expect, it } from 'vitest';

import { collectMcpHeaderEnvRefs } from './mcp-header-env.js';

describe('collectMcpHeaderEnvRefs', () => {
  it('returns [] when there are no header refs', () => {
    expect(collectMcpHeaderEnvRefs({})).toEqual([]);
    expect(collectMcpHeaderEnvRefs({ a: { url: 'http://x' } })).toEqual([]);
    expect(collectMcpHeaderEnvRefs({ a: { command: 'bun', args: [], env: {} } })).toEqual([]);
    expect(collectMcpHeaderEnvRefs({ a: { url: 'http://x', headers: { 'X-Lit': 'literal' } } })).toEqual([]);
  });

  it('collects a single ${VAR} from a header value', () => {
    expect(
      collectMcpHeaderEnvRefs({
        a: { url: 'http://x', headers: { Authorization: 'Bearer ${CUASSISTANT_MCP_TOKEN}' } },
      }),
    ).toEqual(['CUASSISTANT_MCP_TOKEN']);
  });

  it('collects and dedupes refs across servers and header keys', () => {
    expect(
      collectMcpHeaderEnvRefs({
        a: { url: 'http://x', headers: { Authorization: 'Bearer ${TOK_A}', 'X-Extra': '${TOK_A}' } },
        b: { url: 'http://y', headers: { Authorization: 'Bearer ${TOK_B}' } },
      }).sort(),
    ).toEqual(['TOK_A', 'TOK_B']);
  });

  it('collects multiple refs within one value', () => {
    expect(collectMcpHeaderEnvRefs({ a: { url: 'http://x', headers: { X: '${A}-${B}' } } }).sort()).toEqual(['A', 'B']);
  });
});
