/** Tab list + role gating for the playground. Extracted from app.js so the
 *  gating is unit-testable without importing app.js (which runs init() on
 *  load). Department server: owners/TAs see everything; members get the
 *  Home/Chat/Persona/Skills set. */
export const TABS = ['home', 'simple', 'chat', 'persona', 'skills', 'models', 'agents', 'sources', 'retrieval', 'benchmarks', 'status'];

export const MEMBER_TABS = ['home', 'simple', 'persona', 'skills'];

export function hasFullAccess(role) {
  return role === 'owner' || role === 'ta';
}

export function tabsForRole(role) {
  return hasFullAccess(role) ? TABS : MEMBER_TABS;
}
