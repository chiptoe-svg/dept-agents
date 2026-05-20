---
name: add-classroom-pin
description: Add email-PIN 2FA to /add-classroom's class-token URLs. Closes the URL-forwarding gap — bookmarkable URLs alone become "first-device-only credential" that requires a 6-digit PIN delivered to the student's school email before issuing a session cookie. Layers on /add-classroom and /add-resend.
---

# Add Classroom — Email-PIN 2FA on class-token URLs

`/add-classroom`'s class-token URLs (`ncl class-tokens issue`) are bookmarkable + reusable. A student forwarding their bookmark URL to a friend = the friend can be them. This skill gates first-device login behind a 6-digit PIN delivered by email — the friend doesn't have access to the school inbox so the URL forward stops working there.

## What it adds

- **`class_login_pins` table** — short-lived (10-min TTL) scrypt-hashed PIN rows, single-use, 3-attempt rate-limit.
- **`/login/pin`** — entry page with a PIN input form. Auto-issues a fresh PIN when arrived at via `?token=…`.
- **POST `/login/pin/issue`** — mints a PIN, stores its hash, calls the registered sender (Resend) to deliver to the student's email.
- **POST `/login/pin/verify`** — verifies the PIN, mints the playground session cookie, redirects to `/playground/`.
- **Trunk patch (sentinel-bounded, reversible):** when this skill is installed, the existing class-token redeemer redirects to `/login/pin?token=…` instead of setting the session cookie immediately. Without this skill, the original "click URL → in" UX still works.

## Prerequisites

- `/add-classroom` installed (provides the `class_login_tokens` table, the `classroom_roster` table for email lookup, and the redeemer hook this skill plugs into).
- `/add-resend` installed and `RESEND_API_KEY` + `RESEND_FROM_ADDRESS` in `.env` (PIN delivery uses Resend's email API).

## Install

### Pre-flight (idempotent — skip if all true)

- `src/class-login-pins.ts` exists
- `src/db/migrations/module-class-login-pins.ts` exists
- `src/channels/playground/api/login-pin.ts` exists
- `src/channels/playground/public/login-pin.html` exists
- `src/db/migrations/index.ts` imports `moduleClassLoginPins`
- `src/channels/playground/auth-store.ts` contains the `classroom-pin:hook START` sentinel
- `src/channels/playground/server.ts` contains the `classroom-pin:routes START` sentinel

### 1. Copy source files

```bash
mkdir -p src/channels/playground/api src/channels/playground/public
cp -n .claude/skills/add-classroom-pin/add/src/class-login-pins.ts                                     src/
cp -n .claude/skills/add-classroom-pin/add/src/class-login-pins.test.ts                                src/
cp -n .claude/skills/add-classroom-pin/add/src/db/migrations/module-class-login-pins.ts                src/db/migrations/
cp -n .claude/skills/add-classroom-pin/add/src/channels/playground/api/login-pin.ts                    src/channels/playground/api/
cp -n .claude/skills/add-classroom-pin/add/src/channels/playground/api/login-pin.test.ts               src/channels/playground/api/
cp -n .claude/skills/add-classroom-pin/add/src/channels/playground/public/login-pin.html               src/channels/playground/public/
```

### 2. Register the migration

In `src/db/migrations/index.ts`, add (skip individual lines if already present):

```typescript
import { moduleClassLoginPins } from './module-class-login-pins.js';
```

…and add `moduleClassLoginPins` to the `migrations` array.

### 3. Wire the trunk hook

Add this line to your classroom-installed module's bootstrap (e.g. wherever `registerClassTokenRedeemer` is called):

```typescript
import { setPinRequiredForClassToken } from './channels/playground/auth-store.js';
setPinRequiredForClassToken(true);
```

### 4. Wire the PIN sender + token lookup

In your classroom module (where `class_login_tokens` and `classroom_roster` tables are owned), register the sender + token lookup. Example:

```typescript
import { registerPinSender, registerTokenLookup } from './channels/playground/api/login-pin.js';
import { getDb } from './db/connection.js';
import { sendEmail } from './your-resend-wrapper.js'; // your existing Resend wrapper

registerTokenLookup((token) => {
  const row = getDb()
    .prepare(`SELECT t.user_id, r.email
              FROM class_login_tokens t
              INNER JOIN classroom_roster r ON r.user_id = t.user_id
              WHERE t.token = ? AND t.revoked_at IS NULL`)
    .get(token) as { user_id: string; email: string } | undefined;
  return row ? { userId: row.user_id, email: row.email } : null;
});

registerPinSender(async (email, pin) => {
  await sendEmail({
    to: email,
    subject: 'Your sign-in code',
    text: `Your sign-in code is: ${pin}\n\nIt expires in 10 minutes. Do not share this code.`,
  });
});
```

### 5. Build + restart

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## Verify

1. As an instructor, `ncl class-tokens issue --email alice@school.edu` mints a URL.
2. Open the URL in an incognito browser window. You should be redirected to `/login/pin` with a "check your email" message.
3. Check Alice's inbox — the PIN should arrive within seconds.
4. Enter the PIN — you're redirected to `/playground/` with a valid session cookie.
5. Refresh the playground tab — still logged in (cookie persists).
6. Open the original `?token=…` URL again in the same browser — already logged in, no PIN re-prompt.
7. Open the same URL in a second incognito window — PIN re-required.

## Troubleshooting

### "PIN expired" immediately after the email arrives

The 10-minute TTL is shorter than slow-arrival corporate email systems. Check `logs/nanoclaw.log` for the PIN issue timestamp vs the email arrival; if email lands after 10 min, raise `PIN_TTL_MS` in `src/class-login-pins.ts` (currently 600,000).

### PIN never arrives

Check `logs/nanoclaw.log` for `class-login-pins: no PIN sender registered`. If you see that, step 4 wasn't applied — register the sender. If you see `class-login-pins: PIN sender threw` with a Resend error, check `RESEND_API_KEY` + sender domain verification in your Resend dashboard.

### Want to disable PIN temporarily

Comment out `setPinRequiredForClassToken(true)` in your classroom module's bootstrap and restart the host. The redeemer reverts to immediate-cookie behavior; the `/login/pin` endpoints stay registered but become unreachable from the redirect path.
