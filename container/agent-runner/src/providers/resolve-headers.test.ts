import { describe, expect, it } from 'bun:test';

import { resolveHeaders } from './resolve-headers.js';

describe('resolveHeaders', () => {
  it('returns empty object when headers undefined', () => {
    expect(resolveHeaders(undefined, {})).toEqual({});
  });

  it('passes through literal values unchanged', () => {
    expect(resolveHeaders({ 'X-A': 'plain' }, {})).toEqual({ 'X-A': 'plain' });
  });

  it('expands ${VAR} from env', () => {
    expect(resolveHeaders({ Authorization: 'Bearer ${TOK}' }, { TOK: 'secret123' })).toEqual({
      Authorization: 'Bearer secret123',
    });
  });

  it('drops a header whose env reference is missing', () => {
    expect(resolveHeaders({ Authorization: 'Bearer ${TOK}' }, {})).toEqual({});
  });

  it('drops a header whose env reference is empty string', () => {
    expect(resolveHeaders({ Authorization: 'Bearer ${TOK}' }, { TOK: '' })).toEqual({});
  });

  it('keeps other headers when one is dropped', () => {
    expect(resolveHeaders({ 'X-Keep': 'yes', Authorization: 'Bearer ${TOK}' }, {})).toEqual({
      'X-Keep': 'yes',
    });
  });

  it('expands multiple ${VAR} refs in one value', () => {
    expect(resolveHeaders({ 'X-H': '${A}-${B}' }, { A: 'x', B: 'y' })).toEqual({ 'X-H': 'x-y' });
  });

  it('drops a value with multiple refs when any one is missing', () => {
    expect(resolveHeaders({ 'X-H': '${A}-${B}' }, { A: 'x' })).toEqual({});
  });
});
