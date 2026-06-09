// The scenario contract.
//
// A scenario is a thin "skin" over a fixed canonical role set. The PLATFORM
// owns role detection wiring + permission semantics; a scenario only supplies,
// per canonical role it uses, a label + default persona + greeting, plus the
// folder→role mapping for its provisioning convention. Classroom maps
// owner→"Instructor", assistant→"TA", user→"Student" (and doesn't use it_admin);
// corporate scenarios (department, seminar, photo-lab) use all four.
//
// Grounding every scenario in ONE canonical role set keeps permission logic
// written once in the platform and makes a new scenario a relabel + re-persona,
// not a new permission model. See plans/group-agent-platform.md.

/** The fixed canonical roles every scenario draws from. */
export type CanonicalRole = 'owner' | 'it_admin' | 'assistant' | 'user';

export const CANONICAL_ROLES: readonly CanonicalRole[] = ['owner', 'it_admin', 'assistant', 'user'];

/** Platform permission level a canonical role is granted at pair time. */
export type RolePermission =
  | 'global-admin' // owner / it_admin — admin on every agent group
  | 'scoped-admin' // assistant — admin scoped to the member groups
  | 'member'; // user — member of their own group only

/** A scenario's per-role skin: what this role is called + how its agent starts. */
export interface ScenarioRoleProfile {
  /** Scenario-facing label, e.g. "Instructor" for owner in classroom. */
  label: string;
  /** Permission level granted when a member of this role pairs. */
  permission: RolePermission;
  /** Default persona for a newly provisioned member of this role. */
  persona: (memberName: string) => string;
  /** Greeting sent when a member of this role completes pairing. */
  greeting: (memberName: string) => string;
}

export interface Scenario {
  /** Scenario id; matches ACTIVE_SCENARIO. e.g. 'classroom' | 'photo_lab'. */
  name: string;
  /** Canonical roles this scenario uses (a subset is fine), each skinned. */
  roles: Partial<Record<CanonicalRole, ScenarioRoleProfile>>;
  /** Map an agent-group folder to its canonical role (null if not a member). */
  roleForFolder: (folder: string) => CanonicalRole | null;
  /**
   * Resolve a member's display name from its folder, for greeting + persona.
   * Classroom looks it up in the roster; other scenarios may derive it from
   * the agent-group record or the folder. Null when unknown.
   */
  memberName: (folder: string) => string | null;
}
