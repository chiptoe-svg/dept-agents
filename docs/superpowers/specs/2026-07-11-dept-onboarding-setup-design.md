# Department Member Onboarding / Setup (A2) — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-07-11.

## Where this sits (program context)

What began as "homepage polish" decomposed into a 3-part program for the department member experience. This spec covers **A2 only**; A1 and A3 are separate specs/plans, sequenced after A2.

- **A1 · Model & provider foundation (later).** Benchmark real pi agent loops (tool use, multi-step) across candidates — Clemson `qwen3.6-35b-a3b` / `deepseek-v4-pro`, the best local MLX model, and the DGX Spark — and pick defaults on evidence. A *focused* agent-task benchmark, deferred to later in the program. Local models are a **secondary** option (privacy-oriented, future); the **primary** path is the member's own ChatGPT via OAuth.
- **A2 · Member onboarding / setup (THIS SPEC, first).** The member's landing/setup surface that steers them to connect their ChatGPT and offers Telegram + Google, with the free Clemson campus model keeping the agent working meanwhile.
- **A3 · File-centric chat (later).** A separate, purpose-built chat page for agent communication with easy file attach/receive — replaces the reused `simple` tab.

## Goal

Give a department member a first-run landing that (1) actively guides them to connect their own ChatGPT via OAuth (so their AI usage is on their own account), (2) offers optional Telegram and Google Docs/Sheets connections, and (3) never blocks — the agent works from the first second on the free, on-campus Clemson model. Almost all connect infrastructure already exists; A2 surfaces and composes it for members.

## Provider tiering (the model the agent runs on)

1. **Member's own ChatGPT** (connected via OAuth) → their usage bills to them. **The path we steer to.**
2. **Clemson campus model** (free, institution-paid, on-campus, already wired via the credential proxy's `/clemson/*` route) → the **default** when the member hasn't connected / can't. Keeps the agent alive with zero setup and zero marginal cost.
3. **Department paid key** (Anthropic/OpenAI in `.env`) → frontier backstop, unchanged from Plan 4; not emphasized in onboarding.

**Config dependency (in A2 scope):** a newly-provisioned member's **default model must be a Clemson model** so their agent works pre-OAuth. Use the catalog's agent-recommended pick, `qwen3.6-35b-a3b` (`src/providers/clemson-spec.ts`, *"agentic workflows, tool use, longer outputs"*), pending A1 benchmarking. This is a small change to the provisioning default; deep model selection is A1.

## Existing infrastructure to reuse (do NOT rebuild)

- **Connect ChatGPT (OAuth):** `src/channels/playground/public/components/cred-dialog.js` (`openCredDialog`) + endpoints `POST /provider-auth/codex/start`, `POST /provider-auth/codex/exchange`, `GET /api/me/providers`, `POST /api/me/providers/<id>/api-key`, `POST /api/me/providers/<id>/active`, `DELETE /api/me/providers/<id>`. Built in Plan 4; currently surfaced only in owner tabs (home/models/chat).
- **Connect Telegram:** `src/class-telegram-pair.ts` — `POST /api/me/telegram/pair-code` mints a 10-char single-use code (15-min TTL); the member sends it to the bot (`@CUInstructorBot`); `GET /api/me/telegram` reports link state. Fully built; needs a member-facing button + poll.
- **Connect Google Docs/Sheets:** Phase-14 per-user Google OAuth exists (`src/user-provider-auth.ts`, `src/student-creds-paths.ts`, resolved by `getGoogleAccessTokenForAgentGroup`) **but is NOT wired in A2.** Completing the live OAuth requires a one-time GCP Console step (redirect URI + test users + scopes) that isn't done. A2 shows a **greyed-out "Available soon" card** only; enabling it is a deferred follow-up once the GCP step lands.

## Tab structure change

Today: `src/channels/playground/public/app.js` sets `MEMBER_TABS = ['simple']`; members land on `simple`. Owners/TAs get the full `TABS` set.

After A2: **`MEMBER_TABS = ['home', 'simple']`**, members **land on `home`** (the new setup dashboard). The `simple` tab remains the member's chat (labeled "Chat" in the member nav) until A3 replaces it. Owner/TA tab set is unchanged. The new member `home` is a **distinct surface** from the existing owner `home.js` (which stays owner-only); implement it as its own component (e.g. `src/channels/playground/public/tabs/member-home.js`) rather than overloading `home.js`.

## The dashboard (components, top to bottom)

1. **Greeting** — "Welcome, `<display name>`" (from `/api/me/agent` or session).
2. **Hero — Connect your ChatGPT** (primary CTA). Prominent card; button calls `openCredDialog({ providerId: 'codex', … })`. Subtext: "Put your AI usage on your own account." **State-aware:** when `/api/me/providers` shows codex connected, the hero collapses to a quiet "✓ ChatGPT connected — Manage" row.
3. **Reassurance line** — "Your agent already works on the free Clemson campus model — connecting is optional but recommended." No gate anywhere.
4. **Model-status chip** — what the agent currently runs on: *"Your ChatGPT"* when codex is connected, else *"Clemson campus model (free)"*. This is the backstop-visibility element from the original ask.
5. **Secondary cards:**
   - **Telegram** — status (linked / not) + Connect → `POST /api/me/telegram/pair-code`, display the code with "Message @CUInstructorBot with this code," poll `GET /api/me/telegram` until linked (show the 15-min TTL; allow re-mint on expiry).
   - **Google Docs/Sheets** — **greyed-out placeholder** in A2. The card is present (so members see it's coming) but disabled, labeled "Available soon." No live OAuth flow is wired in A2. Enabling it (the Phase-14 per-user Google OAuth) is deferred until the one-time GCP Console step is done, and will be a small follow-up that flips the card from disabled to active.
6. **Go to Chat** — navigates to the `simple`/Chat tab.

## Data flow

On mount, the dashboard fetches (all `credentials: 'same-origin'`):
- `GET /api/me/providers` → ChatGPT (codex) / Anthropic / OpenAI connection states → drives the hero + model-status chip.
- `GET /api/me/telegram` → Telegram link state → Telegram card.
- Google connection state (existing endpoint or a small status read) + a config-present check → Google card.
- The member's effective model (from the group's active-model config) → model-status chip cross-check.

Connect actions reuse the existing endpoints above. On any successful connect, re-fetch the relevant state and re-render the affected card(s). No new credential storage, no new OAuth code.

## Copy

Member-facing strings use **department vocabulary** — "campus model," "your ChatGPT," "your Google Docs/Sheets" — and **never** "class," "student," "instructor," or "ask instructor." The underlying `class_*` / `student-*` code identifiers stay as-is (renaming is slice D); only visible text is dept-appropriate.

## Error handling

- **Nothing blocks** — the Clemson default keeps the agent alive regardless of connection state; the dashboard is never a gate.
- **Google card** is a disabled "Available soon" placeholder in A2 — no OAuth redirect to fail.
- **Telegram pair-code expiry** → show remaining TTL; offer re-mint (endpoint already revokes prior active code).
- **Connect failure** → surfaced by the existing `cred-dialog` error handling.

## Testing

- **Unit (frontend):** the dashboard composes correct card states from mocked `/api/me/*` responses — ChatGPT and Telegram in connected vs not-connected; hero prominent when codex unconnected and collapsed when connected; model-status chip shows "Your ChatGPT" vs "Clemson campus model (free)" correctly; the Google card renders disabled ("Available soon") and is not interactive.
- **Unit (tab gating):** `MEMBER_TABS === ['home', 'simple']`; a member session lands on `home`; owners/TAs unaffected.
- **Reuse:** the connect endpoints (provider-auth, telegram pair-code, google auth) already have tests — A2 does not re-test them, only the new composition.
- **Live:** a member logs in → lands on the setup dashboard → connects ChatGPT (or skips) → sends a message on the Chat tab → agent responds (on their ChatGPT if connected, else Clemson).

## Out of scope for A2

- A3 file-centric chat redesign.
- A1 model benchmark + local/DGX research and selection (A2 uses `qwen3.6-35b-a3b` as a reasonable Clemson default pending A1).
- The `class_*` / `student-*` → department identifier renames (slice D) — only user-visible copy changes here.
- **Live Google Docs/Sheets connect** — the card is a disabled "Available soon" placeholder in A2; wiring the Phase-14 Google OAuth is deferred until the one-time GCP Console step is done.

## Open items to confirm during planning

- Exact endpoint/shape for reading the member's current **effective model** and the **Google connection status** (locate or add a minimal read).
- Where the **provisioning default model** is set (`src/provisioning/*` / container config), to change the new-member default to `qwen3.6-35b-a3b`.
- Whether existing members (already provisioned) need a one-time default-model backfill or only new provisions get the Clemson default.
