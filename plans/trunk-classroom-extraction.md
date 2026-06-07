# Trunk Debt: Extract Classroom / GWS / Student Code to a `classroom` Branch

**Status:** Planned — DO NOT START before the current class term ends. This is
debt cleanup, not a fire. The code compiles and runs correctly today.

**Author:** post-review plan (2026-06-07), following the architecture review.

---

## Why

NanoClaw's design rule (CLAUDE.md §5, "small-trunk-with-skills"): **trunk is
infrastructure every install needs.** Anything channel-, provider-, or
integration-specific lives on a long-lived sibling branch and is copied in by
an `/add-<x>` skill. Channel adapters live on `channels`; non-default providers
on `providers`.

The classroom feature set violates this. ~40 files (~8,000 lines incl. tests)
of classroom / Google-Workspace / student-auth code sit in trunk `src/` and are
**eagerly imported at host startup** (`src/index.ts:21-80`). A fresh trunk-only
install — someone who just wants a personal assistant — still compiles and loads
all of it: enrollment passcodes, login PINs, Telegram pairing, a 1,180-line GWS
MCP tool server, per-student provider auth, class tunnels.

Concretely this costs:

1. **Wrong default.** Trunk should be "personal assistant infrastructure." Today
   it's "Clemson classroom platform." Every non-classroom install carries dead
   weight.
2. **Coupling risk.** `src/container-runner.ts` (core) imports classroom code
   (`class-container-env`). Core should never depend on a feature.
3. **Compile/load cost.** All of it is in the build graph and runs at startup.
4. **The "discovered late" tax.** CLAUDE.md §5 explicitly warns that finding
   classroom/GWS code in trunk after the fact "triggers expensive refactors" —
   this plan is that refactor, deliberately scheduled instead of forced.

**Why it's NOT urgent:** nothing is broken. This is organizational hygiene. The
right time is after the class term, with no deadline pressure on a production box.

## The good news: the boundaries already exist

Prior work left **sentinel markers** demarcating exactly what an install skill
would add/remove:

- `src/index.ts:20-24` — `// ── classroom-provider-auth:hook-registration START/END ──`
- `src/index.ts:69-80` — comment naming the intended skills (`/add-classroom`,
  `/add-classroom-gws`, `/add-classroom-auth`) + the eager `import './class-*.js'` block.
- `src/channels/playground/server.ts:48-62` — `// ── class-enrollment-passcode:imports START/END ──`, `// ── classroom-provider-auth:imports START/END ──`
- `src/channels/playground/server.ts:251,470` — `>>> classroom-pin:redirect START — installed by /add-classroom-pin`

So the original intent was always skill-install; the code just never moved off
main. Extraction = "honor the sentinels."

## Inventory (the ~40 files)

**Root `src/` — classroom core (group: `/add-classroom`):**
`class-config.ts`, `class-container-env.ts`, `class-pair-greeting.ts`,
`class-pair-instructor.ts`, `class-pair-ta.ts`, `class-playground-gate.ts`,
`class-student-provision.ts`, `class-tunnel.ts`, `class-telegram-pair.ts`
(+ tests).

**Root `src/` — class auth (group: `/add-classroom-auth`):**
`class-login-tokens.ts`, `class-login-pins.ts`, `class-enrollment-passcode.ts`,
`student-creds-paths.ts`, `student-provider-auth.ts`,
`classroom-provider-resolver.ts`, `codex-auth-json.ts`, `codex-auth-switch.ts`
(+ tests).

**Root `src/` — Google Workspace (group: `/add-classroom-gws`):**
`gws-auth.ts`, `gws-token.ts`, `gws-mcp-relay.ts`, `gws-mcp-server.ts`,
`gws-mcp-tools.ts` (1,180 lines), `gmail-send.ts`, `student-google-auth.ts`
(+ tests).

**Playground API handlers (move with their group):**
`api/class-base.ts`, `api/class-controls.ts`, `api/enrollment.ts`,
`api/google-auth.ts`, `api/login-pin.ts` (+ tests). (Note:
`api/agent-library-handlers.ts` only *references* class code — keep in trunk,
make the dependency optional.)

**Core coupling to sever:** `src/container-runner.ts` → `class-container-env`.
This is the one place core depends on a feature; must become a registry/hook.

## How

The pattern already used successfully for channels/providers and for the
`studentCredsHook` extension point in `credential-proxy.ts`: **trunk defines a
registry/hook; the branch implements it; a skill copies the files in and appends
the registration at a sentinel.**

### Phase 0 — Map call sites (no code changes)
- `codegraph_impact` each file group to enumerate every cross-boundary edge.
- Classify each edge as: (a) self-contained within a group, (b) trunk→feature
  (must become a hook), or (c) feature→trunk (fine, branch can import trunk).
- Output: an edge list that the later phases tick off. **This is the gate — if
  the edge list shows core logic genuinely entangled, re-scope before moving.**

### Phase 1 — Define trunk extension points
For each trunk→feature edge, add a no-op hook in trunk (mirroring
`setStudentCredsHook`):
- `container-runner.ts`: a `containerEnvContributor` registry so
  `class-container-env` registers instead of being imported. Trunk ships an
  empty registry; behavior identical when nothing registers.
- `index.ts`: the `import './class-*.js'` block becomes skill-appended at a
  sentinel, not hardcoded.
- `playground/server.ts`: route registrations move behind the existing
  sentinels (already partially done for `classroom-pin`).
Land these on `main` first — they're harmless on their own and make trunk
genuinely classroom-agnostic.

### Phase 2 — Create the `classroom` branch
- Branch from `main` after Phase 1.
- Move the three file groups (classroom / auth / gws) + their playground
  handlers onto the branch, deleting them from `main` in the same coordinated
  change set.
- Each group's barrel registers itself against the Phase-1 hooks.

### Phase 3 — Write the install skills
Idempotent `/add-classroom`, `/add-classroom-auth`, `/add-classroom-gws`
(pattern: `git fetch origin classroom` → copy files into standard paths →
append self-registration import at the sentinel → `pnpm install` pinned deps →
build). `/add-classroom-auth` and `-gws` depend on `/add-classroom`.

### Phase 4 — Verify both shapes
- **Trunk-only:** fresh checkout, build, run — confirm no classroom code loads,
  full test suite green minus the moved tests.
- **Classroom install:** run the three skills on a clean install, confirm the
  Clemson deployment behaves identically (enrollment, PINs, GWS tools, per-student
  auth, the credential resolver).
- Re-run the live smoke on the Mac Studio.

## Risks & mitigations

- **Blast radius on production.** Mitigate: do it on a worktree/clone, never edit
  the live `src/` in place; only switch the Mac Studio over after Phase 4 passes.
- **Hidden coupling surfaces during Phase 0.** That's the point of Phase 0 being
  a gate — if entanglement is deeper than the sentinels suggest, re-plan.
- **Test relocation.** Moved files take their `.test.ts` siblings; update
  `vitest` include/exclude if any path assumptions break.
- **`gws-mcp-tools.ts` is 1,180 lines.** Consider splitting it during the move
  (it's doing too much), but only if it doesn't expand scope — otherwise move
  as-is and split later.

## Explicitly out of scope

- No behavior changes. This is a pure relocation + extension-point refactor.
- No new classroom features mixed in.
- Not before the class term ends.

## Definition of done

- `main` builds and runs with zero classroom/GWS/student code loaded.
- `git grep -lE 'class-|classroom-|gws-|student-' src/*.ts` on `main` returns
  nothing (excluding generic trunk hooks).
- `container-runner.ts` has no feature imports.
- The three `/add-classroom*` skills reconstruct the current Clemson behavior on
  a clean install, verified live.
