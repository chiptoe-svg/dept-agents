# Controlled-Access Agent Core — extract the reusable layer; "classroom" becomes one profile

**Status:** Planned, and **cleared to start** — as of 2026-06-07 the classroom
is a pilot/test (breakable, not live production), so the earlier
"do-not-start-before-term-ends" gate is lifted. Still a deliberate
re-architecture, not a fire: sequence it properly (Phases below), don't rush.

**Why not a fork (decided 2026-06-07).** The goal is to expand to new use cases
*and share new features back across them.* Forks diverge: a feature added in one
fork doesn't reach the others without manual cherry-picks, which become hand-
merged conflicts forever as the codebases drift (this repo's v1→v2 history is the
cautionary tale — a fork that couldn't be merged back). A single codebase with a
shared core + thin profile skills gives the sharing for free: core features reach
every profile on update; profile features stay scoped. The cost is *boundary
discipline* (every feature needs a "core vs profile" call) — the right trade when
cross-use-case sharing is the explicit goal. Distribution model: **trunk +
branch-installed profiles** (the existing channels/providers pattern), not a
mono-repo that forces every install to carry every use case's code.

**History:** This started as "extract classroom code to a branch" (2026-06-07).
Revised the same day after the owner identified **three** consumers of the same
machinery — the current classroom, *department agents*, and *another class
focused on agent optimization*. With three real consumers the shared layer is
justified as a first-class reusable core, not a classroom artifact. The earlier
"classroom blob" framing is superseded by the four-tier model below.

---

## The reframe (why this isn't "classroom")

The ~40 "classroom" files are actually three different kinds of thing:

1. **A general controlled-access agent layer** — provisioning individuated
   agents per person, end-user onboarding/auth, per-user + admin-pooled
   credentials, and member capability policy. *None of this is teaching.* It's
   "give a defined set of people controlled, individuated access to agents." All
   three projects need **all** of it.
2. **A thin teaching veneer** — instructor/TA/student vocabulary (really
   admin/moderator/member), roster/enrollment semantics, benchmarks. Small, and
   classroom-specific.
3. **An integration** — Google Workspace (`gws-*`, `gmail-send`). Orthogonal;
   its own skill like any integration.

The `class-`/`student-` naming was *hiding* the generality. Rename it and the
reusable core is obvious. The permission primitives it builds on (`user_roles`,
members, `command-gate`, `canAccessAgentGroup`) are **already in trunk** — trunk
owns the foundation; these files are the onboarding/provisioning/policy layer on
top.

## Decisions locked with the owner (2026-06-07)

- **Topology: separate installs, one profile each.** Department agents and each
  class are their own deployment (own host/DB). The controlled-access layer is
  therefore **shared code**, not a shared runtime — each install stays
  single-cohort. *No `tenant_id` dimension is needed* (this was the big
  data-model fork; it's closed in the simpler direction).
- **Shared scope: the layer covers all four capabilities for all three
  projects** — per-user provisioning, end-user onboarding/auth, per-user BYO
  credentials, admin-pooled creds + member policy. The whole layer is common;
  only veneer + integrations differ.

## Phase 0 findings — requirements across all three consumers (2026-06-07)

Gathered with the owner. This is the gate output: the layer interface is now
validated against department-agents and the agent-opt class, not classroom alone.

| Hook | Classroom | Department | Agent-opt class | Verdict |
|---|---|---|---|---|
| Provisioning | 1 member → 1 agent | both 1→1 personal **and** many→1 shared | 1 member → **N variants** | must support 1:1, N:1, 1:N |
| Onboarding/auth | PIN / passcode / magic-link | admin-adds-manually | self-service (class) | needs self-service **+** admin-provisioned modes; **no SSO yet** |
| Credential resolver | pool + BYO | pool + BYO | pool + BYO | identical contract — genuinely common, unchanged |
| Capability/policy | persona-only | shared agents read-mostly for members | **full agent/variant CRUD** | policy must span persona-only → full CRUD |
| Benchmarks / eval | teaching aside | — | **central** | shared capability, **not** a classroom veneer |

**Two corrections to the earlier framing:**

1. **Provisioning is the stress point — and it maps onto existing primitives.**
   The hook must NOT assume "one person = one agent." It must express three
   relationships: 1 member→1 agent (personal), many members→1 agent (shared
   functional agents), and 1 member→N agents (optimization variants). Trunk
   already models members ↔ agent groups as **many-to-many**
   (`agent_group_members` + the isolation model), so this is orchestration of
   existing primitives, not a new data model. The hook needs two verbs —
   `provisionAgent(member, spec)` and `grantAccess(member, agentGroup)` — instead
   of the hardcoded `student_NN` 1:1 assumption baked into
   `class-student-provision` today.

2. **Benchmarks/eval belongs in the layer, not the classroom profile.** It was
   misfiled as a teaching veneer. Both classroom and agent-opt use it; agent-opt
   makes it central (comparing variants against a benchmark). Move it into the
   controlled-access layer (or a shared `eval` sub-module the layer exposes).

**Non-needs (don't build):** no SSO/SAML for any of the three yet; no
shared-runtime multi-tenancy (separate installs); no fourth-consumer knobs.

## Target architecture (four tiers)

```
trunk (main)            agent infra + permission primitives (already here):
                        sessions, routing, delivery, credential proxy,
                        user_roles / members / command-gate / canAccessAgentGroup

controlled-access       NEW reusable core (own branch, installed by skill):
  layer                 - agent provisioning (1:1, N:1, 1:N) + access grants
                        - onboarding/auth: self-service (tokens/PINs/passcodes)
                          AND admin-provisioned modes
                        - per-user BYO creds + admin pool + resolver
                        - member capability/policy (persona-only → full CRUD)
                        - benchmarks / eval (shared by classroom + agent-opt)
                        renamed off teaching vocabulary

profiles (thin)         classroom         → teaching vocab + roster/enrollment
                        department-agents  → admin provisioning of shared +
                                             personal agents; org naming
                        agent-opt-class    → variant management + eval-centric
                                             curriculum on the shared benchmark layer

integrations            /add-gws (Google Workspace), channels — orthogonal skills
```

## Vocabulary rename

Code identifiers move off the teaching frame; DB columns get a compatibility
migration so existing data keeps working.

| Now | Becomes |
|---|---|
| class / classroom | cohort |
| student | member |
| instructor | admin |
| TA | moderator |
| `class-config`, `class-*` | `cohort-*` |
| `student-provider-auth`, `student-creds-paths` | `member-provider-auth`, `member-creds-paths` |
| `classroom-provider-resolver` | `access-provider-resolver` |

(Keep the term **controlled-access** / **cohort**, not "multi-tenant" — with
separate installs each deployment is single-tenant; "multi-tenant" would
mislead.)

## Distribution

Same pattern as channels/providers, validated by three real consumers:

- The layer lives on a `controlled-access` branch, installed by
  `/add-controlled-access` (idempotent: fetch branch → copy files into standard
  paths → append self-registration at sentinels → install pinned deps → build).
- Each profile is its own skill on top: `/add-classroom`, `/add-department`,
  `/add-agent-opt` — each depends on `/add-controlled-access`.
- `/add-gws` is independent.

The existing sentinel markers (`// ── classroom-provider-auth:... START/END ──`,
`>>> classroom-pin:routes START`) already demarcate most install boundaries —
extraction largely honors them.

## The layer's interface (trunk ↔ layer ↔ profile)

Mirror the existing `studentCredsHook` extension-point pattern. Trunk and the
layer expose registries/hooks the next tier registers against; nothing is
hardcoded into a lower tier:

- **provisioning hook** — two verbs, not a 1:1 assumption (per Phase 0):
  `provisionAgent(member, spec)` (1:1 personal, or 1:N variants) and
  `grantAccess(member, agentGroup)` (many:1 shared agents). Profiles compose
  them: classroom = provision-one-per-roster-row; department = grant-access to
  shared agents + optional provision-personal; agent-opt = provision-N-variants.
- **onboarding/auth registry** — pluggable login methods in two modes:
  self-service (PIN, passcode, magic-link) and admin-provisioned (admin adds the
  member; member still authenticates via magic-link). No SSO yet — don't build it.
- **credential resolver** — already exists (`resolveStudentCreds`): per-user →
  pool → deny. Phase 0 confirmed the contract is identical for all three; just
  generalize the naming.
- **capability/policy provider** — what members may see/do, spanning
  persona-only (classroom) through full agent/variant CRUD (agent-opt). The
  `class-controls` policy, generalized to a wider range.
- **eval/benchmark capability** — shared by classroom and agent-opt (Phase 0
  reclassification); lives in the layer, exposed to profiles that want it.
- **container env contributor** — replaces `container-runner`'s direct import of
  `class-container-env` (the one core→feature coupling to sever).

## Phases

0. **Requirements pass across all three consumers (GATE).** ✅ DONE 2026-06-07 —
   see "Phase 0 findings" above. Outcome: interfaces hold; two corrections
   (provisioning needs 1:1/N:1/1:N; benchmarks move into the layer). No
   interface fractured badly enough to block — proceed when the term ends.
1. **Rename + re-layer in place on `main`.** Apply the vocabulary rename
   (+ DB compatibility migration), introduce the layer's hooks, sever the
   `container-runner` coupling. Behavior identical; lands on `main` first.
2. **Extract the controlled-access layer** to its branch + `/add-controlled-access`.
3. **Carve the classroom profile** into `/add-classroom` (teaching veneer +
   roster/enrollment); benchmarks/eval stays in the layer (Phase 0); move GWS
   into `/add-gws`.
4. **Stand up the two new profiles** (`/add-department`, `/add-agent-opt`) — these
   are the real proof the abstraction is right. If a profile can't be expressed
   cleanly on the layer, the boundary is wrong → back to Phase 0 for that seam.
5. **Verify all shapes** — trunk-only, each profile install, and the live Clemson
   deployment behaving identically.

## Risks & mitigations

- **Designing the layer against classroom alone.** The whole point of three
  consumers is to validate the boundary; Phase 0 + Phase 4 make department and
  agent-opt first-class validators, not afterthoughts.
- **Vocabulary rename touches DB columns** → compatibility migration; rename
  identifiers, not stored data shape, in one coordinated change.
- **Don't over-build.** Three consumers justify the layer; do **not** add knobs
  for a hypothetical fourth. Each interface earns its existence from a concrete
  need in one of the three.
- **Production blast radius** → do it on a worktree/clone; switch the live host
  over only after Phase 5.

## Definition of done

- `main` builds and runs with zero cohort/profile code loaded; the
  controlled-access layer installs cleanly via skill.
- The classroom profile reconstructs current Clemson behavior on a clean
  install, verified live.
- Department-agents and agent-opt-class each stand up as a profile on the same
  layer with no layer changes specific to them beyond their own profile skill.
- `container-runner` has no feature imports.
