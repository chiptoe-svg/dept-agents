import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetScenariosForTest,
  getActiveScenario,
  memberName,
  registerScenario,
  roleForFolder,
  roleProfile,
} from './registry.js';
import type { Scenario } from './types.js';

function fakeScenario(name: string): Scenario {
  return {
    name,
    roles: {
      owner: {
        label: 'Boss',
        permission: 'global-admin',
        persona: (n) => `boss ${n}`,
        greeting: (n) => `hi boss ${n}`,
      },
      user: { label: 'Member', permission: 'member', persona: (n) => `member ${n}`, greeting: (n) => `hi ${n}` },
    },
    roleForFolder: (folder) => (folder.startsWith('boss_') ? 'owner' : folder.startsWith('member_') ? 'user' : null),
    memberName: (folder) => (folder === 'boss_01' ? 'Ada' : folder === 'member_07' ? 'Grace' : null),
  };
}

describe('scenario registry', () => {
  afterEach(() => _resetScenariosForTest());

  it('falls back to the sole registered scenario when ACTIVE_SCENARIO does not match', () => {
    // ACTIVE_SCENARIO defaults to 'classroom'; a single registered scenario
    // under a different name is still returned (the common one-scenario install).
    registerScenario(fakeScenario('photo_lab'));
    expect(getActiveScenario()?.name).toBe('photo_lab');
  });

  it('maps folders to canonical roles via the active scenario', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(roleForFolder('boss_01')).toBe('owner');
    expect(roleForFolder('member_07')).toBe('user');
    expect(roleForFolder('random_03')).toBeNull();
  });

  it('exposes the per-role skin (label/permission/persona/greeting)', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(roleProfile('owner')?.label).toBe('Boss');
    expect(roleProfile('owner')?.permission).toBe('global-admin');
    expect(roleProfile('user')?.persona('Ada')).toBe('member Ada');
    // it_admin not used by this scenario → no skin.
    expect(roleProfile('it_admin')).toBeNull();
  });

  it('rejects duplicate scenario names', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(() => registerScenario(fakeScenario('photo_lab'))).toThrow(/already registered/);
  });

  it('returns null role lookups when no scenario is registered', () => {
    expect(getActiveScenario()).toBeNull();
    expect(roleForFolder('boss_01')).toBeNull();
    expect(roleProfile('owner')).toBeNull();
  });

  it('resolves member names via the active scenario', () => {
    registerScenario(fakeScenario('photo_lab'));
    expect(memberName('boss_01')).toBe('Ada');
    expect(memberName('member_07')).toBe('Grace');
    expect(memberName('random_03')).toBeNull();
  });

  it('returns null member name when no scenario is registered', () => {
    expect(memberName('boss_01')).toBeNull();
  });
});
