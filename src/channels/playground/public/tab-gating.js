/** Tab list + role gating for the playground. Extracted from app.js so the
 *  gating is unit-testable without importing app.js (which runs init() on
 *  load). Department server: owners/TAs see everything; members get the
 *  Home/Chat/Persona/Skills set. */
export const TABS = ['home', 'simple', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks', 'status', 'admin'];

export const MEMBER_TABS = ['home', 'chat', 'persona', 'skills'];

// The tabs shown in the member's top nav bar. Persona/Skills stay in
// MEMBER_TABS (reachable via showTab, opened from the Setup > Advanced
// section) but are NOT top-level nav buttons.
export const MEMBER_NAV_TABS = ['home', 'chat'];

export function hasFullAccess(role) {
  return role === 'owner' || role === 'ta';
}

// 'admin' is owner-only: TAs get every other full-access tab but not this one.
function withoutAdminUnlessOwner(role, tabs) {
  return role === 'owner' ? tabs : tabs.filter((t) => t !== 'admin');
}

export function tabsForRole(role) {
  return withoutAdminUnlessOwner(role, hasFullAccess(role) ? TABS : MEMBER_TABS);
}

export function navTabsForRole(role) {
  return withoutAdminUnlessOwner(role, hasFullAccess(role) ? TABS : MEMBER_NAV_TABS);
}
