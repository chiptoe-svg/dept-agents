# Credential proxy — per-call agent-group attribution

## Why this plan exists

`plans/classroom-web-multiuser.md` Phase 3 (per-student GWS refresh
token) and Phase 4 (per-student provider credentials) both assume the
credential proxy can look up "which agent group is calling" on every
request, then pick per-student credentials over the instructor's
default.

**That capability does not exist yet.** Verified 2026-05-10:
`origin/classroom`'s `src/credential-proxy.ts` rewrites credentials
based purely on path/host routing (`/openai/*`, `/googleapis/*`,
default → Anthropic). It has no concept of *who* is calling. The
existing per-student codex auth (`src/class-codex-auth.ts`) sidesteps
the proxy entirely by mounting `auth.json` into containers at
spawn-time — different mechanism, doesn't generalize to OAuth-bearer
providers like Google Workspace.

Per-student GWS via the proxy is the *first* per-call-attributed
proxy path. This plan picks the attribution mechanism and lays out the
implementation.

## Decision needed: attribution mechanism

Three candidates. Each has a reasonable case; tradeoffs differ.

### Candidate A — request header

Container-runner spawns each container with an `X-NanoClaw-Agent-Group`
header value baked into env. Container-side HTTP clients add the header
to outbound requests. Proxy reads the header, looks up
`agent_groups.metadata.student_user_id`, picks per-student creds.

**Pros:**
- Clear, idiomatic. Easy to inspect in logs / debug.
- Survives container respawn — header value rebuilds from DB.
- No proxy-side stateful tracking.

**Cons:**
- Requires every HTTP client inside the container to add the header.
  Anthropic SDK + Google APIs SDK + custom MCP-tool fetches each need
  the same wrapping. Easy to forget when adding a new caller.
- Header injection is not enforceable against misbehaving container
  code — a student-modifiable container skill could *omit* the header
  and end up using the instructor's creds. Mitigated by: our agent
  containers are not student-controlled at the network layer; the
  worst case is an instructor's-creds fallback, not a privilege
  escalation. Still worth thinking about.

### Candidate B — per-agent-group proxy port

Spawn a separate proxy listener per agent group, each baked with the
right per-student credentials at boot. Container env points at the
agent-group-specific port instead of the shared 3001.

**Pros:**
- Zero container-side cooperation needed. Calls land on the right
  port, get the right creds.
- Strongest isolation — there's no in-band channel for a misbehaving
  container to cross-talk.

**Cons:**
- N proxy listeners for N agent groups. For a 25-student class, 25
  ports + 25 sets of in-process credential state. Not unreasonable on
  a Mac Studio, but does scale linearly.
- Spawn complexity: container-runner needs to start the proxy listener
  alongside the container, tear it down at session end. New failure
  modes around port allocation, leaking listeners.
- Proxy-side code is more stateful — the boot-time credential snapshot
  diverges from `data/student-google-auth/<id>/credentials.json` if
  the file is rewritten (e.g., student re-authes mid-session). Need a
  refresh mechanism.

### Candidate C — source-IP reverse-lookup

Proxy reads `req.socket.remoteAddress`, looks up "which container is
this IP?", then "which agent group does that container serve?"

**Pros:**
- No container-side cooperation.
- No new ports.

**Cons:**
- Requires the host to maintain a container-IP → agent-group map. Docker
  assigns IPs dynamically; need to track via `docker inspect` or hooks.
  Apple Container has different networking primitives.
- Brittle across runtime swaps (Docker ↔ Apple Container).
- IPv6, NAT, and host-mode networking edge cases. The current proxy
  binds to docker0 IP on Linux specifically because cross-runtime
  networking is annoying — adding more dependence on it is risky.

### Recommendation

**Candidate A (request header)**, with one mitigation: the proxy logs
a warning whenever a per-student-eligible agent-group calls without
the header set. That gives us visibility into "container-side caller
forgot to add the header" without breaking the call.

Reasoning: the failure mode (instructor's-creds fallback) is the same
as the current behavior, so missing-header is a graceful degradation,
not a security issue. The single-container-image stays unchanged —
only the in-process HTTP client wrappers need the header. And Apple
Container migration stays unaffected.

If we ever want stronger isolation (e.g., student-controllable
containers that genuinely could not be trusted not to omit the
header), revisit Candidate B then.

## Phased implementation (assuming Candidate A)

### Phase X.1 — header injection on the host side

- `src/container-runner.ts` `buildContainerArgs`: add
  `X_NANOCLAW_AGENT_GROUP=<id>` to the container env at spawn. Bake
  the agent_group_id into the container at spawn time (it doesn't
  change for the container's lifetime).
- `container/agent-runner/src/`: a one-line shim in the existing
  HTTP-client wrapper (or per-fetch helpers) reads the env and adds
  `X-NanoClaw-Agent-Group: <value>` to the headers of every outbound
  request to the proxy. ONE place — not per-SDK.

### Phase X.2 — proxy reads header

- `src/credential-proxy.ts`: read `x-nanoclaw-agent-group` from
  incoming headers (it's lowercased by Node). On miss → fall back to
  current behavior (instructor's creds). On hit → pass to
  per-credential resolvers.
- Helper `resolveAgentGroupForRequest(req): string | null` so the
  read is centralized.

### Phase X.3 — per-student GWS resolver

- New `src/credential-proxy-resolvers/gws-per-student.ts`: given an
  agent_group_id, look up `agent_groups.metadata.student_user_id`,
  read the matching `data/student-google-auth/<sanitized_id>/credentials.json`,
  refresh the access token if expired (mirror existing GWS refresh
  logic), inject `Authorization: Bearer <token>` for `/googleapis/*`
  requests.
- Resolver chain: per-student → instructor default. Same shape as
  `class-codex-auth`'s resolver registration.

### Phase X.4 — instructor provider OAuth (master-plan Phase 1)

The shared-classroom deployment shape: one instructor authorizes
the chosen agent provider (Codex / Anthropic / OpenAI / etc.) once at
setup, and every student agent in the class consumes from that
credential pool. No per-student auth in this phase.

**Scope decision (2026-05-11).** When this phase was first written it
called for "moving codex auth into the proxy" so OAuth refreshes
transparently. Live-install audit showed that on the actually-used
paths the proxy is *already* the refresh point:

| Provider auth shape | Proxy already handles refresh? |
|---|---|
| Codex `auth_mode: "apikey"` (host instructor + class via `CLASS_OPENAI_API_KEY`) | ✅ Container sends Bearer; `/openai/v1/*` route swaps in `.env`'s `OPENAI_API_KEY`. Auth.json is just a placeholder to make codex initialize. |
| Anthropic OAuth (`~/.claude/.credentials.json`) | ✅ `getOAuthToken()` reads the file, refreshes proactively, persists back. |
| Anthropic API key | ✅ Direct injection. |
| OpenAI API key (non-Codex direct use) | ✅ Direct injection. |
| Codex `auth_mode: "chatgpt"` (instructor ChatGPT subscription OAuth) | ❌ Codex bypasses `OPENAI_BASE_URL` for chatgpt-backend calls — proxy never sees the requests. Bind-mounted auth.json on disk is the credential. |

The only path that needs new code to honor the master-plan intent is
the Codex chatgpt mode — and it requires a host-side refresh daemon
(not proxy-time interception) because Codex's chatgpt-backend
endpoint isn't reroutable via `OPENAI_BASE_URL`. That work is
deferred to a Phase 1 follow-up (see `plans/master.md` "Phase 1
follow-ups (deferred)", paired with the `/codex-auth` admin command
which is the natural trigger for flipping a host into chatgpt mode
in the first place).

**X.4 reduced scope:**

- **X.4-verify-apikey.** End-to-end smoke for the class apikey path:
  set `CLASS_OPENAI_API_KEY`, create a temporary `student_test` agent
  group with `agent_provider=codex`, restart host, send a message,
  confirm (a) `data/class-codex-auth.json` was written, (b)
  `classCodexAuthResolver` shadows `instructorHostResolver` in the
  spawn log, (c) the proxy log shows the request hit OpenAI through
  `/openai/v1` with key substitution. Tear down the temp group.
- **X.4-anthropic-regression.** One integration test in
  `credential-proxy.test.ts` covering the `x-nanoclaw-agent-group`
  header path with Anthropic OAuth (the existing `getOAuthToken()`
  refresh path) — confirms X.1–X.3 didn't break it.
- **Setup-flow audit.** Quick read of `/setup` + `/add-classroom-auth`
  SKILL.md to confirm they walk instructor through CLI + provider +
  OAuth. Tighten prompts if a gap is found. No new wiring expected.
- No per-student lookup at this phase — the proxy resolves the
  instructor's credentials for every request.

### Phase X.7 — per-student provider OAuth (master-plan Phase 2)

Phase 2 layers per-student OAuth on top of Phase X.4. Same shape as
X.3 (per-student GWS), applied to LLM providers.

- New resolvers: `anthropic-per-student.ts`, `openai-per-student.ts`,
  `codex-per-student.ts`. Each reads
  `data/student-creds/<sanitized_user_id>/<provider>.json`.
- Resolver chain: per-student → instructor fallback (from X.4).
- **Temp-password / time-bounded fallback.** Students who haven't
  completed provider OAuth yet (or whose token expired) can input a
  one-time code at the homepage that grants them N hours (default 24)
  of "use instructor's pool." Implementation sketch:
  - Instructor generates a temp code (e.g., `ncl temp-creds grant
    --user <user_id> --hours 24` writes to
    `data/student-creds/<id>/_temp.json`).
  - Resolver checks `_temp.json.expires_at > now()` before per-student
    file; if active, returns the instructor's creds.
  - After expiry the file is deleted (or the resolver ignores it) and
    student must complete proper OAuth.
- Magic-link OAuth flow runs on the existing student-auth-server
  (port 3003). Per-provider routes mirror the Phase 14 GWS routes
  (`/openai-auth?t=<token>`, `/anthropic-auth?t=<token>`, etc.).
- Trigger to start: master-plan Phase 2.

### Phase X.5 — observability

- Proxy emits a one-line log per request: `agent_group=<id>
  resolver=<name> credential=<masked>`. Helpful for debugging
  "which student's creds got used."
- Counter / gauge: per-agent-group request rate. Cheap; useful for
  spotting runaway containers.

### Phase X.6 — tests

- Unit: resolver chain tests with mocked DB + filesystem.
- Integration: end-to-end test that a header-bearing request gets
  the per-student creds AND a header-less request gets the default.
- The existing `credential-proxy.test.ts` needs updates if it's
  asserting on current resolver behavior.

## Out of scope

- **Container-side enforcement that the header was set.** See
  recommendation rationale; trade-off accepted.
- **Apple Container networking changes:** the recommended Candidate A
  is runtime-agnostic, so Apple Container migration doesn't affect
  this plan.
- **Container-side enforcement that the header was set:** see
  recommendation rationale above.

## Status

- X.1–X.3 + X.6 ✅ shipped in merge `4161e55` on `main`.
- **X.4 (instructor provider OAuth)** ✅ — verification slice shipped
  (2026-05-11): static wiring audit confirmed `class-codex-auth`
  hooks into host startup, container-runner routes OpenAI through
  proxy, proxy substitutes `.env` key on `/openai/*`. Regression
  test added in `src/credential-proxy.test.ts` ("OAuth mode +
  attribution header"). Skill prompts audited — no gap. Codex
  chatgpt-mode refresh daemon deferred to Phase 1 follow-up,
  bundled with `/codex-auth` admin command.
- **X.5 (observability)** 🛠 — deferred follow-up.
- **X.7 (per-student provider OAuth + temp-password fallback)** 🛠 —
  master-plan Phase 2 work.

Cross-references:
- Triggered by: `plans/master.md` Phase 1 (X.4) and Phase 2 (X.7).
- Pattern reference: `src/class-codex-auth.ts` (existing per-student
  auth resolver, spawn-time mount). X.4/X.7 generalize this to
  proxy-time lookup that works for OAuth-bearer providers.
