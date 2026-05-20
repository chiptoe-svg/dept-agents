# Classroom Per-Person Mode — Design

> **Scope:** This is an INDEX spec — it sets the goal, scope boundaries,
> and success criteria for the per-person classroom mode (formerly
> "Mode B"), and cross-links to the existing per-feature sub-plans
> that hold the implementation detail. It does NOT duplicate those
> sub-plans.

## Goal

Layer per-person Google Workspace OAuth + per-person LLM provider
OAuth on top of Phase 1's shared-classroom MVP, so that each student's
agent operates against THEIR own Drive / quota / API account rather
than the instructor's shared bearer.

Per-person mode does NOT replace shared-classroom mode — both ship
in trunk and the operator picks at deploy time. Shared-classroom
remains the fast-path for short labs and demos where per-person
auth friction outweighs the cost-attribution benefits.

## Why this matters

**Shared-classroom mode (Phase 1, shipped) limits:**

- **Single-point-of-failure.** Instructor's GWS account lockout =
  whole class down. One blocked OAuth token = no Drive for anyone.
- **Quota collisions.** All `/v1/messages` and `/openai/*` traffic
  hits one bearer; a noisy student exhausts the shared rate limit.
- **No per-student cost attribution.** Instructor pays the full
  combined bill; can't see who burned what.
- **Drive ownership friction.** Mode A primitive (read-only ownership
  in `nanoclaw_owners`) is a guardrail against accidental
  overwrites — but it costs students the ability to truly own their
  artifacts. Per-person Drive folders are owned by the student.

**Per-person mode (Phase 2) fixes all four** at the cost of:

- Each student must complete a Google OAuth flow once
- Each student must (eventually) attach their own LLM provider
  account, or operate under a time-bounded temp-code that grants
  instructor-pool access for the onboarding window

## Out of scope (for this design)

- **Multi-class / multi-tenant per host.** One host = one class.
  Separate Phase 3 if it ever becomes a real need.
- **Non-Google identity providers.** GWS OAuth only — no SAML, no
  Okta, no university SSO bridges.
- **Anthropic and OpenAI BYOK billing portal.** Students bring their
  own keys via their existing account; NanoClaw doesn't proxy
  billing.

## Architecture summary

Builds on already-shipped primitives:

| Primitive | Role | Source |
|---|---|---|
| Credential proxy header-based attribution (X.1–X.6) | Per-request `X-NanoClaw-Agent-Group` already lets the proxy resolve the right credentials per call | shipped in Phase 1 |
| `class_login_tokens` + email-PIN 2FA | Identity bound to a stable user_id per student | shipped |
| `classroom_roster` | email → user_id → agent_group_id mapping | shipped |
| Per-group container.json `agent_provider` + `model` | Already routes containers to codex / claude / local per group | shipped |

What changes for per-person mode:

1. **GWS OAuth resolver gains a per-student lookup tier.** Today's
   resolver falls through `instructor` only. Per-person mode adds a
   `per-student` tier ahead of `instructor`, indexed by the
   container's agent_group_id → `data/student-google-auth/<id>/`.
2. **Credential proxy provider resolver gains the same shape** —
   per-student token at `data/student-codex-auth/<id>/auth.json` (and
   eventually `student-anthropic-auth/<id>/`); falls back to
   instructor pool when absent.
3. **Temp-code mechanism** lets the instructor issue time-bounded
   "borrow my pool" tokens during student onboarding so a class
   doesn't have to wait for everyone to finish OAuth before they
   can use their agents.
4. **Student-facing provider settings UI** on the home tab — Google
   OAuth button, codex OAuth button, temp-code redemption form.

The four together let an instructor run an entire class on the
instructor's pool initially, then gradually migrate students to
their own accounts without any single moment of breakage.

## Sub-plans referenced

Implementation detail lives in pre-existing sub-plans; this design
just sequences them.

| Sub-plan | Phase-2 slice |
|---|---|
| [`plans/gws-mcp.md` §Phase 14](../../../plans/gws-mcp.md) | Per-person GWS OAuth — magic-link flow + `~/data/student-google-auth/<id>/` + `/gauth` Telegram command |
| [`plans/credential-proxy-per-call-attribution.md` §X.7](../../../plans/credential-proxy-per-call-attribution.md) | Per-student provider OAuth + temp-code fallback |
| [`plans/gws-mcp-v2.md` §13.5b/c/d](../../../plans/gws-mcp-v2.md) | Calendar / Drive-list / Gmail tools — unlocked by per-person Drive |
| [`plans/classroom-web-multiuser.md` §Phase 4/5/7/8/9](../../../plans/classroom-web-multiuser.md) | Provider settings UI, agent export, RAG strategies, evaluation, walkaway deploy |

## Success criteria

(Mirrors `plans/master.md` Phase 2 success criteria — restated here
so this doc stands alone.)

- A student can complete their own Google OAuth and have their
  agent operate as them against their own Drive (Google's own
  boundary, not NanoClaw's).
- A student can opt into per-person provider OAuth; if they don't
  before the temp code expires, their LLM access stops gracefully.
- An instructor can export an agent in any of four formats
  (`nanoclaw / claude-code / codex / json`) and re-import it cleanly.
- A RAG strategy lab runs end-to-end with side-by-side evaluation.
- A class can be bundled and walked away with — one bootstrap
  script on a fresh VPS reproduces the working state.

## Open questions

- **Temp-code semantics.** Does a temp code grant a full duplicate
  of the instructor pool, or rate-limited shared access? Current
  X.7 plan implies duplicate; revisit if quota-contention shows up.
- **OAuth UX for low-tech students.** The Google OAuth flow is
  fine for CS students; less obvious for non-CS classes. Spec
  assumes CS audience for now.
- **Account-recovery flows.** Lost-link recovery for class-tokens
  is shipped; same flow needed for per-student provider OAuth
  refresh-token loss?

## Phase 1.5 — preconditions (shipped 2026-05-15)

The class-day live work introduced four polish slices that close
small Phase-1 gaps and unblock Phase 2:

1. **Per-call `model_call` trace events** — codex multi-tool turns
   now produce N discrete trace entries instead of one summary.
   Necessary precondition for the RAG-evaluation framework
   (Phase 2 #8/9) which compares strategies' per-call cost.
2. **Auto-refresh codex catalog** — `developers.openai.com/codex/models`
   pulled hourly, drop-on-disappear. Necessary so the per-student
   provider-settings UI (Phase 2 #6) reflects the live OpenAI
   inventory.
3. **Claude support in direct-chat** — `/api/direct-chat` now
   handles the Anthropic Messages wire format. Necessary so
   students can sanity-check their own per-student Claude key
   in Phase 2 #1 without going through agent scaffolding.
4. **Provider/model sync, dropdown-respawn modal, persona
   refresh + dad-joke quirk, raccoon-unicycle rebrand** — UX
   polish that surfaced during the live class.

Commits: `08ae3d1`, `3a10c16`, `9a1769c`, `6d0ecac`, `9400e2a`.
