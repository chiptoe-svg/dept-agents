import { describe, it, expect } from 'vitest';
import { TABS, MEMBER_TABS, hasFullAccess, tabsForRole } from './tab-gating.js';

describe('tab gating', () => {
  it('members get exactly home, simple, persona, skills and land on home', () => {
    expect(MEMBER_TABS).toEqual(['home', 'simple', 'persona', 'skills']);
    expect(tabsForRole('member')).toEqual(MEMBER_TABS);
    expect(tabsForRole('member')[0]).toBe('home');
  });

  it('owners and TAs get the full tab set', () => {
    expect(tabsForRole('owner')).toEqual(TABS);
    expect(tabsForRole('ta')).toEqual(TABS);
    expect(hasFullAccess('owner')).toBe(true);
    expect(hasFullAccess('ta')).toBe(true);
    expect(hasFullAccess('member')).toBe(false);
  });

  it('the full tab set still contains every member tab', () => {
    for (const t of MEMBER_TABS) expect(TABS).toContain(t);
  });
});
