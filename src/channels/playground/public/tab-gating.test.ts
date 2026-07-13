import { describe, it, expect } from 'vitest';
import { TABS, MEMBER_TABS, hasFullAccess, tabsForRole, MEMBER_NAV_TABS, navTabsForRole } from './tab-gating.js';

describe('tab gating', () => {
  it('members get exactly home, chat, persona, skills and land on home', () => {
    expect(MEMBER_TABS).toEqual(['home', 'chat', 'persona', 'skills']);
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

describe('nav vs reachable split', () => {
  it('members reach persona/skills but the top nav shows only Setup(home) + MyAgent(chat)', () => {
    expect(MEMBER_TABS).toEqual(['home', 'chat', 'persona', 'skills']); // reachable (showTab)
    expect(MEMBER_NAV_TABS).toEqual(['home', 'chat']); // nav bar
    expect(navTabsForRole('member')).toEqual(['home', 'chat']);
    // persona/skills are reachable but NOT in the nav
    expect(tabsForRole('member')).toContain('persona');
    expect(navTabsForRole('member')).not.toContain('persona');
    expect(navTabsForRole('member')).not.toContain('skills');
  });
  it('owners/TAs see the full nav', () => {
    expect(navTabsForRole('owner')).toEqual(TABS);
    expect(navTabsForRole('ta')).toEqual(TABS);
  });
});

describe('admin tab — owner only', () => {
  it('navTabsForRole includes admin for owners but not members', () => {
    expect(navTabsForRole('owner')).toContain('admin');
    expect(navTabsForRole('ta')).toContain('admin');
    expect(navTabsForRole('member')).not.toContain('admin');
  });
  it('admin is absent from MEMBER_TABS/MEMBER_NAV_TABS but present in TABS', () => {
    expect(TABS).toContain('admin');
    expect(MEMBER_TABS).not.toContain('admin');
    expect(MEMBER_NAV_TABS).not.toContain('admin');
    expect(tabsForRole('member')).not.toContain('admin');
  });
});
