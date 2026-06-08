# Group-Agent Platform — one codebase, pluggable scenario profiles

**Status:** Active direction (decided 2026-06-08). Supersedes the earlier
"extract controlled-access onto a sibling branch" plan and the even-earlier
"fold everything into a classroom app." Classroom is a pilot (breakable), so
this restructure can proceed in-place with build+test gating.

## The realization (why we're here)

The codebase isn't a classroom app — it's a **group-agent platform**: controlled,
individuated agent access for a defined set of people (provisioning, end-user
onboarding/auth, per-member + pooled credentials, member policy, eval).
"Classroom" is just *one scenario* on top. The owner now wants ~5 distinct
group-agent scenarios (classroom, department agents, agent-optimization class,
+2) that are **not** all classroom.

The file partition proved the shape: ~90% of the "classroom" code is the general
platform; the classroom-specific part is a handful of files (the instructor/TA/
student roles + teaching personas). Every scenario will be a *thin* profile.

## Why one codebase + in-tree profiles (not lean-trunk-plus-branch)

The owner tried both prior models and they failed for concrete reasons:
- **Lean trunk + branch-installed feature** (the nanoclaw default): the
  branch-sync ceremony got messy and large for a feature this size. With 5
  scenarios it's 5 branches + 5 skills to keep in sync — the ceremony cost is
  real and was felt.
- **Fold into a classroom app:** too narrow once non-classroom scenarios appeared.

Resolution, given the scenario code is *tiny*: **trunk IS the platform; each
scenario is a small in-tree profile selected by config.** Separate installs run
the same codebase with different scenario config + data. A new platform feature
reaches every install on `git pull`/update — no branch dance. A new scenario is
a new small profile directory. The only cost — every install carrying all
scenario profiles — is negligible because each profile is tiny.

## Target structure

```
src/                         the PLATFORM (controlled-access core):
  (provisioning, onboarding/auth, creds + resolver, member policy, eval,
   routing, two-DB, container orchestration, credential proxy, …)

src/scenarios/               thin per-scenario profiles, one dir each:
  index.ts                   loads the active scenario(s) by config
  classroom/                 instructor/TA/student roles + teaching personas
  department/                org roles (shared + personal agents)        [later]
  agent-opt/                 variant management + eval-centric curriculum [later]

config: ACTIVE_SCENARIO (.env, per install; defaults to classroom here)
```

A scenario profile registers its bits against existing trunk registries
(pair-consumer registry, playground-gate registry, policy, personas). Only the
**active** scenario's profile loads, so an install behaves as exactly one
scenario.

## What is platform vs profile (from the partition manifest)

**Platform (stays in `src/`, shared by all scenarios):** onboarding/auth
(login tokens/PINs/passcodes, telegram pairing), provisioning + access grants,
credentials (`user-provider-auth`, `user-provider-resolver`, codex auth bridge,
env-to-owner migration, owner-creds-ready), member policy (playground gate,
class-controls → member-controls), base pairing (`class-pair-greeting`),
container env (member git identity), guest tunnel, cohort config, eval/benchmarks.

**Classroom profile (`src/scenarios/classroom/`):** the instructor/TA pair
consumers (`class-pair-instructor`, `class-pair-ta`) + the teaching personas/role
tiers (`STUDENT_PERSONA`/`TA_PERSONA`/`INSTRUCTOR_PERSONA` from class-skeleton)
+ classroom-specific config.

**GWS integration:** stays an optional add-on (orthogonal to scenarios) —
`gws-*`, `gmail-send`, `student-google-auth`, `api/google-auth`. Any scenario
can use it; it is not scenario-specific.

## Phases

1. **Scaffold `src/scenarios/` + scenario registry + selection config.** Create
   the classroom profile dir, move the pure-profile files (`class-pair-instructor`,
   `class-pair-ta`) into it, add `ACTIVE_SCENARIO` config + a `scenarios/index.ts`
   that loads the active scenario. Wire `index.ts` to load via the registry
   instead of hardcoded `import './class-pair-*.js'`. Build+test; classroom
   still works as the active scenario. ← START HERE.
2. **Migrate the rest of the teaching-specific bits** into the classroom profile
   (personas/role tiers from `class-skeleton`, any classroom-only config), leaving
   the platform genuinely scenario-agnostic.
3. **Rename for clarity (optional, low priority — owner said names don't matter):**
   classroom-flavored platform identifiers → neutral (cohort/member). Defer; do
   opportunistically when touching a file.
4. **Retire the branch model:** archive/remove the `classroom` sibling branch +
   `/add-classroom*` skills (superseded by in-tree scenarios). Note deprecation.
5. **Add the next scenarios** (`department/`, `agent-opt/`) as new profile dirs —
   the proof the platform/profile boundary is right.

## Risks & notes

- **Breakable pilot** → in-place restructure is fine, but gate every step on
  build + full test suite, and restart-verify after stored-state-adjacent changes
  (the credential-dir migration bug earlier is the cautionary tale).
- **Don't over-rename** — owner said names don't matter; vocabulary cleanup is
  Phase 3, opportunistic, never blocking.
- **Separate installs share this repo** — a platform feature lands once and all
  installs `git pull` it; scenario profiles are tiny and shipped to all.
- The Phase 0 requirements (provisioning must support 1:1 / N:1 / 1:N; benchmarks
  are shared not classroom-only; resolver contract is common) still hold and
  inform the platform/profile boundary.

## Definition of done (for the restructure)

- `src/scenarios/classroom/` holds the teaching-specific profile; the platform in
  `src/` has no scenario-specific role/persona code.
- `ACTIVE_SCENARIO` selects the loaded profile; classroom verified working.
- A second scenario (`department/`) can be added as a profile dir with no platform
  changes specific to it.
- The `classroom` branch + `/add-classroom*` skills are retired.
