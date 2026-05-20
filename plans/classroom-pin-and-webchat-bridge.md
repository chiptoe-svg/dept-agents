# Classroom PIN auth + webchat bridge

Two skills that close the remaining ❌ items from the student-onboarding walkthrough.

## Skill 1: `/add-classroom-pin`

**Why:** class-token URLs from `ncl class-tokens issue` are bookmarkable + reusable, so a student forwarding the URL = the friend can be them. Email-PIN on first device closes that gap.

**Flow:**
1. Student clicks class-token URL on first device
2. Redeemer detects no valid session cookie → redirects to PIN-entry page (with pending-token reference in URL)
3. PIN issued + emailed via Resend (10-min TTL, 3-attempt limit, single-use, bcrypt-hashed)
4. Student enters PIN → cookie issued → redirected to playground
5. Returning visits within cookie TTL skip the PIN

**Files (in skill):**
- `add/src/class-login-pins.ts` — mint/verify, bcrypt, rate-limit
- `add/src/db/migrations/module-class-login-pins.ts` — `class_login_pins` table (token_id, pin_hash, expires_at, attempts, used_at)
- `add/src/channels/playground/api/login-pin.ts` — `POST /login/pin/issue`, `POST /login/pin/verify`
- `add/src/channels/playground/public/login-pin.html` + `.js` — entry form
- Trunk patch (sentinel-bounded, reversible): hook into the class-token redeemer to require PIN step

**Skill artifacts:** SKILL.md (install instructions), REMOVE.md (sentinel-based unpatch), VERIFY.md (smoke).

**Effort estimate:** 3-4 hours.

## Skill 2: `/add-classroom-webchat`

**Why:** webchat is the chat surface; v3 playground is the workbench. Bridge integrates them: students log into webchat once (using class-token URL or email-PIN), chat with their agent, and request playground access via `/playground` chat command which delivers a magic link.

**Flow:**
1. Student opens email's class-token URL → goes through PIN dance (skill 1)
2. Cookie set; webchat treats them as authenticated
3. Webchat's room list shows their assigned agent only (per-student lock)
4. Student types `/playground` in chat → bot replies with v3 playground magic link
5. Click magic link → playground for tuning

**Files (in skill):**
- `add/src/channels/webchat/class-redeemer.ts` — class-token query-param handler, sets webchat session cookie via existing `mintSessionForUser`
- `add/src/channels/webchat/class-commands.ts` — recognize `/playground` in chat input, mint magic link via existing `mintMagicToken`
- Trunk patches:
  - webchat's auth handler routes `?token=X` through the class redeemer
  - webchat's room list filter restricts students to their assigned agent (via classroom_roster lookup)
  - webchat's command/message dispatch checks for `/playground` first

**Skill artifacts:** SKILL.md, REMOVE.md, VERIFY.md.

**Effort estimate:** 4-6 hours.

## Build order

1. **`/add-classroom-pin`** first — `/add-classroom-webchat` reuses the PIN infrastructure for webchat first-device login.
2. **`/add-classroom-webchat`** second — depends on #1.

## Out of scope (defer)

- Per-student rate limiting beyond per-PIN (DDOS protection at the platform layer)
- TOTP / WebAuthn 2FA (out of scope; email-PIN is "good enough" per the user's threat model)
- PIN reset / regenerate UI for instructors (use `ncl` CLI for now)
- Migration of existing class-token URLs to PIN-mode (new tokens get PIN; existing tokens stay PIN-less until they re-issue)
- Audit log of PIN issues / verifies (logs go to `nanoclaw.log`; structured audit table is post-MVP)

## Testing constraint

This Linux host does NOT have `/add-classroom` installed (we cleaned up partial state earlier). To smoke-test these skills here, we'd need to install `/add-classroom` first. Alternatively, build, ship, and rely on Mac Studio for first real smoke. **Decision: install `/add-classroom` on this Linux host for smoke testing as we go.** It's idempotent, doesn't disturb the running v3 playground, and gives us a real test bed.
