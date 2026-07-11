# A2 Member Onboarding — live verification

**Date:** 2026-07-11. A2 plan, Task 4. Executed live on the running department server (`com.nanoclaw-v2-581fefa4`, playground at `http://gcworkflow.clemson.edu:8088`, local bind `127.0.0.1:3002`).

## Result: PASS — a new member lands on the Home dashboard and their agent works on the free Clemson default before any login.

Rebuilt + restarted, then provisioned a throwaway member `playground:a2_canary` (group `ag-1783767401597-heisus`) via `./bin/ncl users provision`.

## 1. Provisioned default model is the free Clemson model

`container_configs` for the canary group:
```
model=qwen3.6-35b-a3b-fp8 | model_provider=clemson | provider=pi
```
So a brand-new member's agent is configured to run on the free, on-campus Clemson model with zero setup — the intended pre-OAuth default. (The id is the real served id with the `-fp8` suffix; the bare `qwen3.6-35b-a3b` does not exist on the endpoint — a Critical caught and fixed in Task-3 review.)

## 2. The member gets the right tabs and lands on the Home dashboard

Served build assets (under the `/playground/` path, session-gated):
- `tab-gating.js` → `MEMBER_TABS = ['home', 'simple', 'persona', 'skills']`.
- `app.js` imports `tab-gating` + `member-home`, and routes the `home` tab via `hasFullAccess(window…)` → `mountMemberHome` for members.
- `tabs/member-home.js` contains "Connect your ChatGPT", "Clemson campus model (free)", "Available soon", and the OAuth-only `oauth-token` spec.

Live browser (Playwright, member session) rendered the dashboard:
- **Nav:** Home / Chat / Persona / Skills (the four member tabs).
- **Hero:** "Connect your ChatGPT" (prominent) + "Put your AI usage on your own account" + Connect button.
- **Reassurance:** "Your agent already works on the free Clemson campus model — connecting is optional but recommended."
- **Model chip:** "Running on: Clemson campus model (free)."
- **More connections:** Telegram [Connect]; Google Docs/Sheets — Available soon [Connect **disabled**].
- **Go to Chat →** present.

`GET /api/me/agent` → `{user:{id:"playground:a2_canary",role:"member"}, agent:{folder:"a2_canary"}}` (member role, own folder).

## 3. Connect entry points resolve for the member

- `GET /provider-auth/codex/status` → `{hasApiKey:false,hasOAuth:false,active:null}` → drives the prominent (not-connected) hero.
- `GET /api/me/telegram` → `{paired:false,botUsername:"CUInstructorBot"}` → Telegram card in unpaired state.
- `POST /api/me/telegram/pair-code` → `{code,expiresAt,botUsername}` → the Connect flow mints a code.

## 4. A real turn works on the Clemson default, pre-OAuth (the headline)

Posted a turn as the canary (no ChatGPT connected): *"In one short sentence, what is 17 times 3? Then say READY."* The container spawned (`192.168.65.18`) and the agent replied. `messages_out`:
```
seq 339 | provider=clemson | model=qwen3.6-35b-a3b-fp8 | tokens_out=178
content: {"text":"17 times 3 is 51. READY."}
```
Correct answer, correct instruction-following — on the free campus model, with zero member setup. This also confirms the open Clemson model drives a basic agent turn (a light data point for the A1 benchmark later).

## Cosmetic findings (for triage, not blockers)

- **Greeting shows the raw user id.** The dashboard renders "Welcome, playground:a2_canary" because `/api/me/agent`'s `user` object carries no email/display name, so `mountMemberHome` falls back to `user.id`. A real member sees "Welcome, playground:<handle>". Should use a friendlier name (the agent name is available as `window.__pg.agent.name`, or surface the provisioned display name).
- **Banner still reads "NanoClaw Classroom"** (classroom-heritage branding) — part of the deferred `class_*` rename (slice D), not A2.
- **Bot username "@CUInstructorBot"** contains "Instructor" — a product-level naming question for the dept pilot.

## Teardown

The `a2_canary` throwaway identity was removed after verification (token revoked, agent group + membership deleted, container stopped).
