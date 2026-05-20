import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveClaudeImports } from './claude-imports.js';

describe('resolveClaudeImports', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-imports-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('inlines @<path> import directives', () => {
    fs.writeFileSync(path.join(tmp, 'fragment.md'), 'fragment body');
    const out = resolveClaudeImports('header\n@./fragment.md\nfooter', tmp);
    expect(out).toBe('header\nfragment body\nfooter');
  });

  it('recurses into nested imports', () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(tmp, 'b.md'), 'leaf');
    expect(resolveClaudeImports('@./a.md', tmp)).toBe('leaf');
  });

  it('drops missing files silently (returns empty for that import)', () => {
    expect(resolveClaudeImports('keep\n@./missing.md\nkeep', tmp)).toBe('keep\n\nkeep');
  });

  it('breaks cycles instead of recursing forever', () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(tmp, 'b.md'), '@./a.md');
    expect(() => resolveClaudeImports('@./a.md', tmp)).not.toThrow();
  });
});
