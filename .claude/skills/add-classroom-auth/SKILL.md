---
name: add-classroom-auth
description: DEPRECATED — use /add-classroom-provider-auth instead. (Old per-student Codex OAuth via auth.json upload + magic-link form. Superseded 2026-05-17 by a proper per-provider registry, paste-back OAuth, instructor-controlled class-pool fallback, and a Home Providers card.)
---

# Add Classroom — Per-Student Auth ⚠️ DEPRECATED

**Superseded by `/add-classroom-provider-auth` (Phase X.7, 2026-05-17).**

The new skill does everything this one did, plus:
- Supports both Anthropic AND OpenAI as providers (this one was Codex-only)
- Paste-back OAuth flow (matches the vendor CLIs' actual OAuth client redirect URIs)
- Class Controls table for per-provider policy (`allow` / `provideDefault` / `allowByo`)
- Active-method toggle (subscription vs API key) when a student has both connected
- Trunk extension via `studentCredsHook` so the credential proxy resolves per-request
- A Home Providers card students use to manage their own credentials

If you've never run `/add-classroom-auth` on this install, **skip this skill entirely** and run `/add-classroom-provider-auth` instead.

If you've already run this skill and have students using the auth.json upload flow, leave it in place; it still works. But future students should onboard via the new skill.

---

(Original instructions below for installations that still depend on this flow.)

# Add Classroom — Per-Student Auth

Layered on top of `/add-classroom`. Adds:

- A magic-link HTTP server that lets students upload the
  `auth.json` produced by `codex login` on their laptop.
- A pair-time consumer that issues a fresh magic link and DMs the
  URL right after pairing.
- A `/login` Telegram command for re-issuing auth links any time.
- A codex provider auth resolver that picks the per-student
  `auth.json` over the instructor's host one.
- A container-side helper for detecting refresh failures and
  triggering a re-auth nudge to the student.
- The `request_reauth` delivery action that turns container-side
  refresh failures into a fresh magic link sent to the student.

## Prerequisites

- `/add-classroom` must be installed first. The skill aborts otherwise.
- A reachable public URL for the magic-link server. Students click
  the link from their phone; localhost won't work for class
  deployments. Set `NANOCLAW_PUBLIC_URL` in `.env` before
  provisioning a real class. (The skill installs fine without it;
  pair-time auth links just render with a fallback message.)

## Install

### Pre-flight (idempotent)

Skip to **Configure** if all of these are in place:

- `src/student-auth.ts`, `src/student-auth-server.ts`,
  `src/student-auth-handlers.ts`, `src/class-codex-auth.ts`,
  `src/class-telegram-commands.ts`, `src/class-pair-auth.ts`,
  `container/agent-runner/src/auth-nudge.ts` exist
- `src/index.ts` includes the four auth-related imports
- `STUDENT_AUTH_PORT`, `STUDENT_AUTH_BIND_HOST`, `NANOCLAW_PUBLIC_URL`
  exist in `src/config.ts`

### 1. Verify base skill is installed

```bash
[ -f src/class-pair-greeting.ts ] || { echo "Run /add-classroom first."; exit 1; }
```

### 2. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 3. Copy the auth-specific files

```bash
git show origin/classroom:src/student-auth.ts            > src/student-auth.ts
git show origin/classroom:src/student-auth.test.ts       > src/student-auth.test.ts
git show origin/classroom:src/student-auth-server.ts     > src/student-auth-server.ts
git show origin/classroom:src/student-auth-server.test.ts > src/student-auth-server.test.ts
git show origin/classroom:src/student-auth-handlers.ts   > src/student-auth-handlers.ts
git show origin/classroom:src/class-codex-auth.ts        > src/class-codex-auth.ts
git show origin/classroom:src/class-telegram-commands.ts > src/class-telegram-commands.ts
git show origin/classroom:src/class-pair-auth.ts         > src/class-pair-auth.ts
mkdir -p container/agent-runner/src
git show origin/classroom:container/agent-runner/src/auth-nudge.ts      > container/agent-runner/src/auth-nudge.ts
git show origin/classroom:container/agent-runner/src/auth-nudge.test.ts > container/agent-runner/src/auth-nudge.test.ts
```

### 4. Append the self-registration imports

Append these lines to `src/index.ts` (skip if present):

```typescript
import './class-codex-auth.js';
import './class-pair-auth.js';
import './class-telegram-commands.js';
import './student-auth-handlers.js';
```

### 5. Add the auth-related config exports

Append to `src/config.ts` (skip if present):

```typescript
const studentAuthEnv = readEnvFile(['NANOCLAW_PUBLIC_URL', 'STUDENT_AUTH_BIND_HOST']);
export const STUDENT_AUTH_PORT = parseInt(process.env.STUDENT_AUTH_PORT || '3003', 10);
export const STUDENT_AUTH_BIND_HOST: string =
  process.env.STUDENT_AUTH_BIND_HOST || studentAuthEnv.STUDENT_AUTH_BIND_HOST || '0.0.0.0';
export const NANOCLAW_PUBLIC_URL: string =
  process.env.NANOCLAW_PUBLIC_URL || studentAuthEnv.NANOCLAW_PUBLIC_URL || '';
```

### 6. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

## Configure (instructor-side)

1. **Set `NANOCLAW_PUBLIC_URL` in `.env`**:
   ```
   NANOCLAW_PUBLIC_URL=https://your-host.example.com
   ```
   This is the public-facing URL the student-auth server is
   reachable at. If your install runs behind a tunnel (cloudflared,
   ngrok, tailscale funnel), use the tunnel hostname.

2. **Open `STUDENT_AUTH_PORT` (default 3003)** if it's not behind
   a reverse proxy that forwards `/student-auth/*` to it.

3. **Restart the host** so the new exports get picked up:
   ```bash
   systemctl --user restart nanoclaw   # or the macOS launchd equivalent
   ```

## What students experience

After pairing, the auth consumer adds a third short message:

> Hi Alice! Welcome to class. Send /playground any time to customize…  ← greeting
> Your Google Drive folder is shared with you here: …                  ← gws (if installed)
> Connect your ChatGPT account so I run on your subscription instead   ← auth
> of your instructor's: https://your-host.example.com/student-auth?t=…
> (Send /login any time to get a fresh link…)

The student runs `codex login` on their laptop, opens the link, and
drags `~/.codex/auth.json` onto the page (or pastes its contents).
After upload, future agent activity for that student burns their
ChatGPT subscription quota; the codex provider's resolver chain
picks up `data/student-auth/<user_id>/auth.json` over the
instructor's host auth.

If the refresh token later expires (rare — they last weeks), the
container detects it and the host auto-DMs a fresh magic link.

## Refresh-failure detection caveat

The detection regex in `container/agent-runner/src/auth-nudge.ts`
is best-effort — calibrated against likely error patterns but not
yet against a real Codex refresh failure. If you observe the agent
appearing broken after a token expires AND no nudge fires, check
`logs/nanoclaw.log` for the actual error string and update the
regex in auth-nudge.ts.

## Where this fits in the deploy story

This skill is the per-student-auth layer for the **per-person
classroom** mode (master plan Phase 2). It assumes students will
authorize their own ChatGPT subscriptions and the instructor's
pool acts as a fallback.

For the simpler **shared classroom** mode (one instructor key,
shared by all students) you do NOT need this skill — just set
`CLASS_OPENAI_API_KEY` in `.env` during `/add-classroom` step 5.
See [`docs/shared-classroom.md`](../../../docs/shared-classroom.md).
