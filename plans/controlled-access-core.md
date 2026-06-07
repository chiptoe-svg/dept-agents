# Controlled-Access Agent Core — extract the reusable layer; "classroom" becomes one profile

**Status:** Planned — DO NOT START before the current class term ends. Debt
cleanup + a small re-architecture, not a fire. The code compiles and runs today.

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

## Target architecture (four tiers)

```
trunk (main)            agent infra + permission primitives (already here):
                        sessions, routing, delivery, credential proxy,
                        user_roles / members / command-gate / canAccessAgentGroup

controlled-access       NEW reusable core (own branch, installed by skill):
  layer                 - per-user agent provisioning + wiring
                        - end-user onboarding/auth (tokens, PINs, passcodes)
                        - per-user BYO creds + admin pool + resolver
                        - member capability/policy (visible tabs, allowed actions)
                        renamed off teaching vocabulary

profiles (thin)         classroom         → teaching vocab + roster/enrollment + benchmarks
                        department-agents  → org naming/onboarding (reqs TBD)
                        agent-opt-class    → eval/optimization focus (reqs TBD)

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

- **provisioning hook** — how a profile maps "a person" to an agent group +
  wiring (classroom: roster row; department: org unit; agent-opt: signup).
- **onboarding/auth registry** — pluggable login methods (PIN, passcode,
  magic-link, future SSO for department).
- **credential resolver** — already exists (`resolveStudentCreds`): per-user →
  pool → deny. Generalize the naming; keep the contract.
- **capability/policy provider** — what members may see/do (the `class-controls`
  policy, generalized).
- **container env contributor** — replaces `container-runner`'s direct import of
  `class-container-env` (the one core→feature coupling to sever).

## Phases

0. **Requirements pass across all three consumers (GATE).** Document what
   department-agents and the agent-opt class need from each interface — not just
   classroom. If their needs diverge enough to fracture an interface, redesign
   that interface before moving code. *Do not design the layer against the
   classroom shape alone.*
1. **Rename + re-layer in place on `main`.** Apply the vocabulary rename
   (+ DB compatibility migration), introduce the layer's hooks, sever the
   `container-runner` coupling. Behavior identical; lands on `main` first.
2. **Extract the controlled-access layer** to its branch + `/add-controlled-access`.
3. **Carve the classroom profile** into `/add-classroom` (teaching veneer +
   roster/enrollment + benchmarks); move GWS into `/add-gws`.
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
