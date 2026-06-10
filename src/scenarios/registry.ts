// Scenario registry + active-scenario selection.
//
// Scenarios self-register at import time (via src/scenarios/index.ts). The
// active scenario is chosen by the ACTIVE_SCENARIO config (per install). The
// platform calls roleForFolder() / roleProfile() instead of importing any
// scenario-specific role logic directly. See plans/group-agent-platform.md.

import { ACTIVE_SCENARIO } from '../config.js';
import type { CanonicalRole, Scenario, ScenarioRoleProfile } from './types.js';

const scenarios = new Map<string, Scenario>();

export function registerScenario(s: Scenario): void {
  if (scenarios.has(s.name)) throw new Error(`scenario already registered: ${s.name}`);
  scenarios.set(s.name, s);
}

export function activeScenarioName(): string {
  return ACTIVE_SCENARIO;
}

/**
 * The active scenario. Resolves ACTIVE_SCENARIO; if that name isn't registered
 * but exactly one scenario is, returns it (the common single-scenario install).
 */
export function getActiveScenario(): Scenario | null {
  const name = activeScenarioName();
  if (scenarios.has(name)) return scenarios.get(name)!;
  return scenarios.size === 1 ? [...scenarios.values()][0]! : null;
}

/** Canonical role for an agent-group folder under the active scenario. */
export function roleForFolder(folder: string): CanonicalRole | null {
  return getActiveScenario()?.roleForFolder(folder) ?? null;
}

/** The active scenario's skin for a canonical role (label/persona/greeting). */
export function roleProfile(role: CanonicalRole): ScenarioRoleProfile | null {
  return getActiveScenario()?.roles[role] ?? null;
}

/** The active scenario's display name for the member in `folder` (null if unknown). */
export function memberName(folder: string): string | null {
  return getActiveScenario()?.memberName(folder) ?? null;
}

/** Folder prefix the active scenario uses to provision a member of `role` (null if unset). */
export function folderPrefix(role: CanonicalRole): string | null {
  return getActiveScenario()?.folderPrefix[role] ?? null;
}

/** Run the active scenario's post-provision hook, if any. No-op otherwise. */
export function onMemberProvisioned(
  folder: string,
  member: { name: string; email: string; role: CanonicalRole },
): void {
  getActiveScenario()?.onMemberProvisioned?.(folder, member);
}

export function listScenarios(): string[] {
  return [...scenarios.keys()];
}

/** Test-only: drop all registrations. */
export function _resetScenariosForTest(): void {
  scenarios.clear();
}
