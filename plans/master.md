# NanoClaw gccourse — master plan

Two-phase delivery plan for this fork. Phase 1 ships a working
shared-classroom MVP on shared workspace + shared LLM credit pool. Phase 2
adds per-person accounts, RAG-driven labs, exports, and walkaway
deploy. Detailed designs live in the sub-plans referenced inline;
this file is the sequencing layer.

## What's shipped

| Subsystem | Where it landed |
|---|---|
| AI-coding-CLI picker (Phases A–G, all shipped) | `main`, commits per `plans/ai-coding-cli-pick.md` |
| Agent Playground v2 | installed via `/add-agent-playground`, declared SHIPPED in `plans/agent-playground-v2.md` |
| Class feature foundation (`/add-classroom*` skills) | `origin/classroom` branch |
| Multi-user playground session store (classroom Phase 1) | `main` (merge `7e5398d`) |
| Google OAuth + roster + minimal home (classroom Phase 2) | `main` (merge `f7d1fa8`) |
| Per-student GWS refresh-token persistence — write side (classroom Phase 3 slice A) | `main` (same merge) |
| `--roster <csv>` flag in `class-skeleton.ts` (slice B CSV import) | `origin/classroom` (merge `63d87c7`) |
| Playground module split (Tier A audit refactor) | `main` |
| `setup-cli` → `ai-coding-cli` rename | `main` (merge `af34009`) |
| Credential-proxy per-call attribution (X.1–X.3 + X.6) | `main` (merge `4161e55`) |
| Per-student GWS read in proxy (classroom Phase 3 slice B) | `main` (folded into `4161e55`) |
| GWS MCP server + relay — Phase 13.2 + 13.3 | `main` (merge `4161e55`) |
| GWS MCP container → relay + `/add-gws-tool` skill — Phase 13.4 | `main` (commit `cecfb36`) |
| Phase 13.5 V2 surface — mode-aware sub-plan | `main` (commits `e8aede2` + `bb337d9`); no tools landed yet |
| Phase 13.6 ownership primitive — shared-classroom mode friction sub-plan | `main` (commit `0f5df8a`); built on `feat/gws-skill-refactor` (commits `28e2c45`, `670de8d`, `06d7493`) — installed by `/add-classroom-gws` |
| `wasFallback` infra — `{ token, principal }` from `getGoogleAccessTokenForAgentGroup` (Phase 1 #1) | `main` (commit `90caf28`) — `gws-token.ts` kept in trunk |
| GWS small-trunk-with-skills refactor (rule 5) — base GWS → `origin/gws-mcp`, ownership ext → `origin/classroom`, skills rewritten to install | `main` (merge `88db845`) — branch `feat/gws-skill-refactor` deleted |
| credential-proxy Phase X.4 — instructor provider OAuth (verification slice) | `main` (commit `52b1837`) |
| **Phase 1 closure — docs + first follow-ups** | |
| `docs/shared-classroom.md` — end-to-end deploy guide | `main` (commit `8090500`) |
| Docs rollout — README "Deploying a classroom" subsection, `docs/isolation-model.md` classroom section, four `/add-classroom*` SKILL.md cross-links, "Mode A/B" → "shared-classroom/per-person" rebrand across 5 files | `main` (commits `1b5abe9`, `1b71052`) |
| Stale student-side docs cleanup — `student-playground-setup.md` deleted, `student-setup-guide.md` → `add-web-hosting.md` (renamed + npm→pnpm) | `main` (commit `141ea07`) |
| AI-coding-CLI neutralization — present Claude Code + Codex as a real operator choice in README, shared-classroom guide, architecture, setup-flow, setup-wiring | `main` (commit `602dc2c`) |
| Phase 1 follow-up — ufw docker0 → 3007 documentation in `/add-gws-tool` step 9b | `main` (commit `42d0dfc`) |
| Phase 1 follow-up — `/login` "Lost your link?" form + Resend integration | trunk hook + form: `main` (commit `b1a0346`); classroom-side recoverer + Resend send: `origin/classroom` (commit `25e0c41`) |
| Playground UI redesign — A (theme unification, dark → light, lobster mascot), B (brand palette + favicon + topbar), D (mode-tabs as pills, agent-markdown rendering, multi-line chat + ⌘↵, file dirty indicator, themed scrollbars, mobile breakpoint), bug fixes (duplicate escapeHtml, #mode-chat specificity, no-cache headers, cache-bust) | `main` (commits `3d4cdd1`, `db51afe`, `702939d`, `60ab860`, `62df9aa`, `27eb5f4`) |
| Playground trace panel — tool-call / tool-result surfacing via new ProviderEvents → messages_out kind=`trace` → playground SSE → right-side trace panel. Claude SDK provider only; Codex/OpenCode/Ollama follow-up. | `main` (commit `a83794d`) |
| **Agent Playground v3 — student-first 4-tab redesign** (Chat / Persona / Skills / Models, 3-tier library, model whitelist, per-message cost annotations, provider-uniform persona-layers helper). Spec: [`docs/superpowers/specs/2026-05-13-agent-playground-v3-design.html`](../docs/superpowers/specs/2026-05-13-agent-playground-v3-design.html). Plan: [`docs/superpowers/plans/2026-05-13-agent-playground-v3.html`](../docs/superpowers/plans/2026-05-13-agent-playground-v3.html). | `worktree-playground-v3` branch, commit range `01c0e5f`..`cbd3974` (24 tasks across 7 phases + prettier hygiene, awaiting `/ultrareview` + merge to `main`) |

**Phase 1 status: complete.** All 9 build-order items shipped; refactor merged; deploy guide written; two follow-ups shipped (ufw doc, lost-link form). Phase 2 unblocked.

## Active sub-plans (referenced from the delivery phases below)

| Plan | Subject |
|---|---|
| [gws-mcp.md](gws-mcp.md) | GWS MCP V1 (Docs) + Phase 13.6 ownership primitive + Phase 14 per-person OAuth |
| [gws-mcp-v2.md](gws-mcp-v2.md) | GWS V2 tool surface — sheets / calendar / drive-listing / gmail / slides |
| [credential-proxy-per-call-attribution.md](credential-proxy-per-call-attribution.md) | Header-based attribution + provider OAuth resolvers (X.4 instructor / X.7 per-student) |
| [classroom-web-multiuser.md](classroom-web-multiuser.md) | The 9-phase classroom web rebuild; phases referenced individually below |
| [ai-coding-cli-pick.md](ai-coding-cli-pick.md) | AI-coding-CLI picker (A–G all shipped — design record) |
| [upstream-pr-prep.md](upstream-pr-prep.md) | Per-subsystem PR-readiness tracker for upstream `qwibitai/nanoclaw` |
| Phase 2 index — design / plan | [`docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md`](../docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md) + [`docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md`](../docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md) — scope + sequencing layer that ties the per-feature sub-plans above into the Phase 2 phased delivery |

Archived: `agent-playground-v2.md` (SHIPPED — kept as design record).

## Phase 1.5 — post-class polish (shipped 2026-05-15)

Slices discovered and shipped DURING the live class day. None
pre-planned in Phase 1; recorded here because Phase 2 #8/9 (RAG
evaluation framework) depends on the per-call trace breakdown
landed here.

| Slice | Commit |
|---|---|
| Per-call `model_call` ProviderEvent — codex multi-tool turns produce N discrete trace entries instead of one summary; client-side renderer in chat.js | `3a10c16` |
| Auto-refresh codex catalog from `developers.openai.com/codex/models` — 24h cache, drop-on-disappear, falls back to BUILTIN_ENTRIES on failure | `9a1769c` |
| Claude support in `/api/direct-chat` (Anthropic Messages wire format, system-field extraction, max_tokens default) | `9400e2a` |
| Provider/model sync on `/provider` switch (resets model to new provider's `default:true` entry); chat-tab model dropdown now PUTs `active-model` + respawn modal; `setModel` kills running containers so changes take effect on next message | `08ae3d1` |
| Persona refresh: `STUDENT_PERSONA` gains a "Quirk" section asking for a dad joke per reply (discoverability hook), applied to all 12 students via `scripts/refresh-student-personas.ts` | `08ae3d1` |
| Raccoon-unicycle rebrand: "NanoClaw Playground" → "Agent Playground", new `/agent-playground-icon.png` route | `6d0ecac` |
| `.gitignore` for `class-roster.csv` + `config/class-controls.json`, removal of `scripts/wire-test-student.ts` | `37dbdad` |
| Codex provider rewrite: emit `tool_use` / `tool_result` ProviderEvents from `item/started` / `item/completed` (matching Claude provider's trace richness); rename `token_count` → `thread/tokenUsage/updated` (codex v0.124+); rename custom TOML provider `openai` → `openai-custom` (codex now reserves built-in IDs) | `08ae3d1` |
| InstructorBot's `allowedModels` synced to current BUILTIN_ENTRIES codex list (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2; dropped stale gpt-5-mini / gpt-5.5-pro) | local-only (groups/ is gitignored) |

**Verification:** email-PIN sign-in flow confirmed working
end-to-end during class with the 10 real Clemson students.

## Phase 1 — shared-classroom MVP

**Goal.** A class can deploy with: one Google Workspace OAuth
(instructor's, shared by everyone), one LLM provider OAuth
(instructor's, shared as a credit pool), a homepage students log into
via personal email, an embedded Agent Playground, and working
Drive/Sheets/Calendar/Slides tools with NanoClaw-side ownership
friction. No per-student GWS or per-student LLM auth yet.

**Setup story (the experience we're delivering).** Instructor runs
`/setup`, picks a CLI and authorizes it, picks an agent provider
(typically Codex/OpenAI) and authorizes it, runs `/add-classroom` +
`/add-classroom-gws` to provision the class workspace, then
`/add-gws-tool` to wire GWS into student agents. Students get
homepage URL + Telegram link; they log in via personal email; their
LLM calls run on instructor's pool; their docs live in the class
workspace with anyone-with-link sharing.

### Build order

The order matters: each item below depends on the one or two above
it. Items at the same nesting depth can run in parallel.

1. ✅ **`wasFallback` infra prerequisite.** Shipped on `main`
   (commit `90caf28`). `getGoogleAccessTokenForAgentGroup` returns
   `{ token, principal: 'self' | 'instructor-fallback' }`. Used by
   13.6 and every 13.5* tool.
2. ✅ **gws-mcp Phase 13.6 — shared-classroom mode ownership primitive.** Built
   on `feat/gws-skill-refactor` (commits `28e2c45`, `670de8d`,
   `06d7493`). After the refactor merge, this code lives on
   `origin/classroom` and is installed by `/add-classroom-gws`.
   Details: [gws-mcp.md §13.6](gws-mcp.md).
   **Refactor follow-on:** The whole GWS surface was extracted from
   trunk to `origin/gws-mcp` + `origin/classroom` per rule 5
   (commits `dc7f429`, `1d0bbac` on `feat/gws-skill-refactor`).
   Trunk keeps `gws-auth.ts` (playground needs it) + `gws-token.ts`
   (credential proxy needs it).
3. ✅ **gws-mcp Phase 13.5a — Sheets read/write.** Shipped on
   `origin/gws-mcp` (commit `c5c614d`) + `/add-gws-tool` SKILL.md
   updated on `main` (`5e7e0c1`). Details: [gws-mcp-v2.md §13.5a](gws-mcp-v2.md).
4. ✅ **gws-mcp Phase 13.5e — Slides create/append/replace-text.**
   Shipped on `origin/gws-mcp` (commit `7c61346`) + `/add-gws-tool`
   SKILL.md updated on `main` (`1d3deb3`). Same ownership-tag
   mechanism as Docs/Sheets (Slides are Drive files). Details:
   [gws-mcp-v2.md §13.5e](gws-mcp-v2.md).
   *(13.5b Calendar pushed to Phase 2 — see "GWS Phase 1 closes here"
   note below.)*
5. ✅ **credential-proxy Phase X.4 — instructor provider OAuth
   (verification slice).** Live-install audit (2026-05-11) found
   that the proxy already handles every provider auth shape this
   install actually uses (Codex apikey, Anthropic OAuth, raw API
   keys). The only path needing new code is Codex `auth_mode:
   "chatgpt"`, which bypasses `OPENAI_BASE_URL` entirely and needs a
   host-side OAuth refresh daemon — deferred to a Phase 1 follow-up,
   paired with the `/codex-auth` admin command. X.4 reduced to:
   (a) static verification of the class apikey wiring chain
   (`src/index.ts:20` imports `class-codex-auth`, container-runner
   sets `OPENAI_BASE_URL` to proxy, proxy swaps in `.env`'s
   `OPENAI_API_KEY` on `/openai/*`), (b) regression test in
   `credential-proxy.test.ts` for the `x-nanoclaw-agent-group`
   header on the Anthropic OAuth path (8 tests pass, was 7),
   (c) audit `/setup` + `/add-classroom` SKILL.md prompts — no
   gap, CLI pick covered by `nanoclaw.sh`, provider+OAuth covered
   by `/add-classroom` step 5. Live end-to-end smoke deferred to
   first real class deploy. Details:
   [credential-proxy-per-call-attribution.md §X.4](credential-proxy-per-call-attribution.md).
6. ✅ **classroom Phase 4 (Phase-1 slice) — class login tokens
   (the URL-as-identity flow).** Shipped: trunk hook
   `registerClassTokenRedeemer` on `main` (commit `a730aa8`);
   classroom-side `class-login-tokens.ts` + migration + CLI resource
   on `classroom` branch (commit `c7298b0`); `/add-classroom` SKILL.md
   updated. Instructor mints `ncl class-tokens issue --email <e>` per
   roster row, distributes the URLs via their channel of choice. Lost-
   URL recovery via `ncl class-tokens rotate --email <e>`. Full Phase 4
   (dashboard, Telegram link, provider settings) deferred until OAuth
   unblocks browser smoke + Mac Studio LAN IP is assigned. Web
   self-serve "Lost your link?" form + Resend integration tracked as
   a Phase 1 #6 follow-up (~1.5 hr) — not blocking #7 onward.
7. ✅ **classroom Phase 6 — local-LLM runbook + .env.** Shipped:
   `docs/local-llm.md` (mlx-omni-server / Ollama / LM Studio install +
   `.env` config + sizing guidance + troubleshooting). Credential-proxy
   audit done — `OPENAI_BASE_URL` already supports arbitrary upstream
   hosts cleanly (no hardcoded `openai.com` checks, host/port/protocol
   driven by the parsed URL). `/add-classroom` SKILL.md links the
   runbook as a local-LLM alternative to `CLASS_OPENAI_API_KEY`.
8. ✅ **ai-coding-cli Phase G — smoke matrix.** Programmatic coverage
   shipped in `setup/lib/ai-coding-cli/resolve.test.ts` (11 tests
   covering install-state + env-var combinations non-destructively
   via per-adapter `isInstalled()` mocking). Destructive-scenario
   items (uninstall a CLI, force setup failure, terminal-prompt UX)
   deferred to deployment-time verification with the live matrix
   tracked in [upstream-pr-prep.md §1](upstream-pr-prep.md). Live
   install state verified (both `claude` + `codex` installed; no
   `NANOCLAW_AI_CODING_CLI` set, so setup would hit the
   two-installed-picker branch on re-run). Adapter contract that the
   picker depends on already covered by `index.test.ts`.
9. ✅ **`scripts/gws-authorize.ts`** — already existed (commit `7e54dd9`
   from May 6, predating the plan note that said "still pending").
   Enhanced today to deliver the OAuth URL via a tmp file (mode 0600)
   instead of inline-print only — matches the
   `feedback_gws_auth_flow` memory note that terminal wrap breaks
   copy-paste. Inline URL kept as a fallback. SIGINT cleanup wipes
   the URL file on Ctrl-C since it has the client_id embedded.

### Phase 1 success criteria

- Instructor runs `/setup` end-to-end without manual file edits and
  ends up with a class workspace + provider auth + working agent
  groups + working homepage stub.
- A test student can log into the homepage via their bookmarked
  `?token=...` URL (no Google OAuth required), access the embedded
  playground, and trigger an LLM call that hits the class API
  credit pool (or instructor ChatGPT OAuth as fallback / local LLM
  if configured).
- A test student can ask their agent to create a Google Doc; the
  doc lands in the class workspace with `nanoclaw_owners` set and
  anyone-with-link sharing. Anyone with the link (instructor /
  other students who get it shared) can open it.
- A second student cannot delete or overwrite the first student's
  doc through their agent — relay returns the hard-block error
  with the creator's display name.
- Sheet read/write and slides create/append/replace-text work
  end-to-end; writes on someone else's doc/sheet/slides are
  hard-blocked in shared-classroom mode.
- Local LLM deploy (mlx-omni-server / Ollama / LM Studio per
  `docs/local-llm.md`) is a documented alternative to the API
  credit pool; `/model` Telegram command discovers models from the
  local server's `/v1/models`.

(Calendar, Gmail, Drive listing deferred to Phase 2 — they earn
their utility only when each user has their own Google account.
Provider settings UI / dashboard / Telegram link panels deferred
until OAuth + Mac Studio LAN IP unblock.)

## Phase 2 — Full classroom capability (per-person accounts + labs)

**Goal.** Layer per-person Google Workspace OAuth (per-person mode) and
per-person provider OAuth on top of Phase 1, add agent export,
RAG-driven labs with evaluation framework, and walkaway cloud deploy.

**Design + sequencing.** Detailed scope, architecture summary, and
sub-plan cross-links live in the Phase 2 index docs:
[`docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md`](../docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md)
(scope + success criteria + open questions) and
[`docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md`](../docs/superpowers/plans/2026-05-15-classroom-per-person-mode.md)
(checkbox build order with sub-plan links per slice). The build-order
list below remains the canonical sequencing layer for cross-Phase
dependency tracking.

### Build order

1. **Phase 14 — per-person GWS OAuth (per-person mode).** Magic-link flow on
   the student-auth-server, per-user credentials at
   `data/student-google-auth/<id>/`, `/gauth` Telegram command.
   Partly blocked on GCP redirect URI registration — see
   `project_gcp_oauth_pending` memory. Details:
   [gws-mcp.md §Phase 14](gws-mcp.md).
2. **credential-proxy Phase X.7 — per-student provider OAuth +
   temp-password fallback.** Students authorize their own provider
   account via magic-link; resolver falls back to instructor pool if
   no per-student token. Instructor can issue a time-bounded temp
   code (`ncl temp-creds grant --user X --hours 24`) that grants
   instructor-pool access during student onboarding. Details:
   [credential-proxy-per-call-attribution.md §X.7](credential-proxy-per-call-attribution.md).
3. **gws-mcp Phase 13.5b — Calendar list/create.** Earns its keep
   once each user has their own calendar (per-person mode). In shared-classroom mode it
   collapses to a single shared workspace calendar and doesn't need
   agent tooling. Details: [gws-mcp-v2.md §13.5b](gws-mcp-v2.md).
4. **gws-mcp Phase 13.5c — Drive listing.** Safe to expose once
   per-person mode lands — Google's own auth scopes the result. Details:
   [gws-mcp-v2.md §13.5c](gws-mcp-v2.md).
5. **gws-mcp Phase 13.5d — Gmail search/send.** Same reasoning.
   Details: [gws-mcp-v2.md §13.5d](gws-mcp-v2.md).
6. **classroom Phase 4 (Phase-2 slice) — provider settings panel.**
   Adds the homepage UI for students to manage their own provider
   OAuth + GWS OAuth + temp-code redemption.
7. **classroom Phase 5 — agent export tooling.**
   `nanoclaw / claude-code / codex / json` formats; `GET
   /api/draft/<folder>/export?format=…`. Spec in
   [classroom-web-multiuser.md §Phase 5](classroom-web-multiuser.md).
7b. **NEW: classroom Phase 5b — Agent library + save/swap UX
   (UNPLANNED).** Distinct from §5 (which is one-direction export
   for take-home). 5b is the in-playground File-menu-for-agents:
   Save current agent state as a named library entry, Save As to
   create a new entry, Open to swap the active agent, optional
   versioning / branching. `library/default-agents/*.json` is the
   seed storage but the wrapping UX is undesigned. Needs a spec +
   plan pair under `docs/superpowers/` before execution. Probably
   slots before Phase 5 (export) since export depends on the
   "what's the current agent" notion being clearly addressable
   — though both could land independently and reuse the same
   underlying `groups/<folder>/` source of truth.
8. **classroom Phase 7 — expert system builder + RAG strategies.**
   Pipeline framework + named strategies + UI. Cost-economical only
   after Phase 1 #8 (local-LLM runbook) lands. Spec in
   [classroom-web-multiuser.md §Phase 7](classroom-web-multiuser.md).
9. **classroom Phase 8 — evaluation framework.** Side-by-side
   comparison + LLM-as-judge mode. Depends on Phase 7 (nothing to
   evaluate without strategies). Spec in
   [classroom-web-multiuser.md §Phase 8](classroom-web-multiuser.md).
10. **classroom Phase 9 — walk-away cloud deploy.** Bundle +
   bootstrap script. Depends on Phase 5 (export) for the bundle
   format. Spec in
   [classroom-web-multiuser.md §Phase 9](classroom-web-multiuser.md).

### Phase 2 success criteria

- A student can complete their own Google OAuth and have their
  agent operate as them against their own Drive (Google's own
  boundary, not NanoClaw's).
- A student can opt into per-person provider OAuth; if they don't
  before the temp code expires, their LLM access stops gracefully.
- An instructor can export an agent in any of four formats and
  re-import it cleanly.
- A RAG strategy lab runs end-to-end with side-by-side evaluation.
- A class can be bundled and walked away with — one bootstrap
  script on a fresh VPS reproduces the working state.

## Phase 1 follow-ups (deferred)

Items surfaced during Phase 1 work but not blocking the close-out.
Slot into Phase 2 or a small interleave when convenient.

- ~~**Web "Lost your link?" form on `/login`** + Resend integration~~
  ✅ shipped 2026-05-12. Trunk hook (`registerLostLinkRecoverer` +
  POST `/login/recover` route + form) on `main` (commit `b1a0346`);
  classroom-side recoverer + Resend send on `origin/classroom`
  (commit `25e0c41`). Anti-enumeration: identical success response
  whether email is on roster or not. Three RESEND_* env vars in
  `.env` enable it (same vars as `/add-resend`); falls back to
  "contact instructor" message when unset. 3 new vitest cases.
- **Trace surfacing for non-Claude providers** (Codex, OpenCode,
  Ollama, …). The playground's trace panel renders tool calls / tool
  results in real time (commit `a83794d`), but only the Claude SDK
  provider currently emits the underlying `tool_use` / `tool_result`
  ProviderEvents. Each non-default provider needs an equivalent scan
  in its `translateEvents` (Codex's app-server protocol, OpenCode's
  stream shape, etc.) — same envelope shape so the client renderer
  doesn't need per-provider branches. **~30 min per provider**; do
  when the operator's actual class agent provider lands somewhere
  other than `claude`. Files to touch:
  - `container/agent-runner/src/providers/codex.ts` (lives in trunk)
  - `container/agent-runner/src/providers/opencode.ts` (`providers`
    branch — needs porting via `/add-opencode` skill update too)
  - any future provider's `translateEvents`
  The `kind: 'trace'` route in `src/delivery.ts` and the client
  renderer in `app.js` are provider-agnostic — provider work only.
- **Codex ChatGPT-subscription OAuth refresh daemon** + **`/codex-auth`
  Telegram admin command.** Bundle: the admin command flips
  `~/.codex/auth.json` into chatgpt mode, and the daemon keeps it
  refreshed thereafter. ~3 hr total (~1 hr command + ~2 hr daemon).
  Surfaced when scoping X.4 (2026-05-11) — current install runs
  apikey mode exclusively (verified: `~/.codex/auth.json` has
  `auth_mode: "apikey"`, no `tokens`, no `last_refresh`), and the
  proxy already swaps in `.env`'s `OPENAI_API_KEY` for that path. The
  chatgpt path is master-plan Phase 1 success criterion #2's
  "instructor ChatGPT OAuth as fallback" and is reachable but
  unexercised on this install; build when someone needs it.
  **Daemon shape:** mirror the Anthropic OAuth refresh primitive
  already in `credential-proxy.ts` (`getOAuthToken()` +
  `refreshAnthropicOAuthToken()` + single-flight guard +
  persist-back). New module `src/codex-oauth-refresher.ts`, timer
  refreshes ~5 min before `tokens.expires_at`, writes back via the
  codex CLI's own writer (not hand-rolled JSON — see auth.json
  format note below). Lives on trunk because it's auth infra, not
  classroom-specific.
  **Admin command (`/codex-auth`)** alongside `/auth`, `/model`,
  `/provider`. Flips `~/.codex/auth.json` between ChatGPT
  subscription OAuth (`auth_mode: "chatgpt"`) and OpenAI API key
  mode (`auth_mode: "apikey"` — note **no underscore** in codex's
  format) without hand-editing the file. Companion to `/auth`
  (which only switches Anthropic mode); make this the codex-aware
  equivalent.
  **Implementation note:** the codex auth.json format is poorly
  documented and trivially easy to get wrong — when I first tried
  to hand-roll `auth_mode: "api_key"` (underscored, mirror of
  Python style) codex returned 401 on `/v1/responses`. The
  correct path is to shell out to the codex CLI's own writer:
  `printenv OPENAI_API_KEY | codex login --with-api-key` for
  api-key mode, and `codex logout` + tell the user to re-run
  `codex login` for chatgpt mode (the latter requires interactive
  browser auth, can't be fully automated from Telegram).
  Lives on `admin` branch alongside the other admin handlers.
- ~~agent_groups.agent_provider ↔ container.json drift~~ ✅ fixed
  on `admin` branch (commit `9074e0c`) — `setProvider` now updates
  `agent_groups.agent_provider` alongside `container.json` and
  `sessions.agent_provider`. Regression test pinned in
  `provider-switch.test.ts`. Found during Phase 1 verification
  when `/model` listed Claude models for a codex group on this
  install; root cause was setProvider only updating 2 of 3 sources.
  Existing installs may have drifted rows from before this fix —
  one-off SQL to reconcile:
  `UPDATE agent_groups SET agent_provider = (SELECT json_extract(...))`
  is doable but not worth scripting for the handful of groups
  affected; manual `ncl groups update --provider <p>` works too.
- ~~**Container can't reach GWS relay on port 3007** when ufw is
  active without an explicit allow rule for docker0 traffic~~ ✅
  fixed 2026-05-12 — `/add-gws-tool` SKILL.md step 9b documents
  the `sudo ufw allow in on docker0 to any port 3007 proto tcp`
  rule + the verify step.

## Cross-cutting

- **Live in-browser smoke for classroom Phases 1–3.** Gated on the
  Mac Studio having a LAN IP + the GCP redirect URI being registered
  for that IP. See `project_gcp_oauth_pending` memory.
- **Upstream `qwibitai/nanoclaw` PR candidates.** Tracked per
  subsystem in [upstream-pr-prep.md](upstream-pr-prep.md). Phase 1
  (multi-user playground fix) is the cleanest standalone candidate;
  held until live verification.
- **Branch hygiene.** Merges to `main` and to `origin/classroom` use
  `--no-ff` so each phase stays revertable as a single merge commit.
  Feature branches deleted (local + remote) once merged.
- ~~**Modernize the `origin/classroom` long-lived branch.**~~
  **RESOLVED 2026-05-17 via path (a).** Merged `origin/main` into
  `origin/classroom` as commit `bfa1175`. Main-wins on 9 conflicts.
  12 classroom-skill-source-of-truth files restored (main had deleted
  them via Phase 11.3 "strip class feature from main"). Three files
  needed API surface updates against current trunk: `class-drive.ts`
  migrated `googleapis` → `@googleapis/drive`; `student-auth-server.ts`
  inlined the 3 classroom-specific config consts that Phase 11.3
  stripped from trunk; `student-auth-server.test.ts` mock fix. One
  classroom-side fix preserved: `auth_mode: 'apikey'` in
  `class-codex-auth.ts` (commit `44562b5`) — flagged as possible
  backport-to-main since trunk currently has `'api_key'` which may
  also be wrong. Build clean, 816/816 tests on merged tip.
  Future cadence: re-merge `main` forward into `origin/classroom`
  periodically (same pattern as `origin/channels`, `origin/providers`,
  `origin/gws-mcp`) to prevent drift accumulating again.
- **`/ultrareview` policy.** Per the `feedback_ultrareview_before_merge`
  memory: run `/ultrareview` *before* merging feature work, not
  after. Going forward, build phase items on feature branches and
  review-then-merge.

## How to use this file

- When starting a session, read the current phase's build order and
  pick the first unblocked item.
- When an item ships, record its merge commit in the "What's shipped"
  table at the top.
- When a sub-plan adds new phases or new design decisions, update
  the relevant Phase 1 or Phase 2 section here so the delivery
  ordering stays accurate.
- When all Phase 1 items are shipped, declare Phase 1 complete and
  shift focus to Phase 2. Don't start Phase 2 items early — keep
  the delivery boundary clean.
