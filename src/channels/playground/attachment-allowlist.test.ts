import { describe, it, expect } from 'vitest';
import { isAllowedAttachment } from './attachment-allowlist.js';

describe('isAllowedAttachment', () => {
  it('accepts typical work files (case-insensitive)', () => {
    for (const n of ['a.pdf', 'b.DOCX', 'c.pptx', 'deck.KEY', 'data.csv', 'x.xlsx', 'notes.md', 'q.json'])
      expect(isAllowedAttachment(n)).toBe(true);
  });
  it('rejects executables and unknown types', () => {
    for (const n of ['evil.exe', 'run.sh', 'lib.dll', 'app.app', 'x.bat', 'y.msi', 'z', 'noext'])
      expect(isAllowedAttachment(n)).toBe(false);
  });
  it('rejects path-y or empty names safely', () => {
    expect(isAllowedAttachment('')).toBe(false);
    expect(isAllowedAttachment('../../etc/passwd')).toBe(false); // no allowed extension
  });
});
