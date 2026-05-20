# Class Enrollment Passcode

In-class passcode-based enrollment for the playground. Replaces Google-sign-in-on-landing with email + classwide passcode. Internal-network-only deployment; no email sender needed.

## Flow

**First-time enrollment (in class):**
1. Student opens the playground URL (posted to Canvas).
2. `login.html` shows: email input + passcode input.
3. Student types `their.email@clemson.edu` + the passcode the instructor is showing on their own Home card.
4. Server validates: passcode matches current hash, email is on `classroom_roster`, that roster row's `enrolled_at` is NULL (first-come-first-served).
5. Session minted, drops them in the playground.

**Subsequent logins:**
- Cookie persistence (default).
- DM `/playground` to bot if Telegram paired (existing).
- Worst case: they email the instructor, instructor either rotates the passcode and re-shares OR resets the student's `enrolled_at`.

**Instructor:** sees a Home card "Today's enrollment passcode: **4729**  [Rotate]" — owner/admin only. Rotation generates a new 4-digit code; old code stops working immediately.

## Threat model
- Internal network only (Clemson VPN / on-campus).
- Passcode shown in class verbally → "knowledge of class" factor.
- Roster email check → "on the roster" factor.
- First-come-first-served → at most one impersonation possible per student per term (manually resolvable when the real student complains).

## Components

### Backend (lands on `main`)

- **`src/db/migrations/module-class-enrollment-passcode.ts`** — new module migration. Creates `class_enrollment_passcodes(id INTEGER PRIMARY KEY, passcode_hash TEXT NOT NULL, created_at TEXT NOT NULL, rotated_by_user_id TEXT)`. Single-row pattern (delete old row on rotate). Plus alters `classroom_roster` to add `enrolled_at TEXT` (nullable) and `enrollment_session_id TEXT` (nullable).

- **`src/class-enrollment-passcode.ts`** — module exporting:
  - `getCurrentPasscode()` — returns `{ passcode_hash, created_at } | null`
  - `getCurrentPasscodeCleartext()` — returns the cleartext IFF set in process (since hash is one-way, cleartext only available right after rotation; cache in module-local Map keyed by rotation timestamp; survives until next rotation)
  - `rotatePasscode(rotatedByUserId)` — generates 4 digits, scrypt-hashes, stores, returns cleartext (+ caches it for getCurrentPasscodeCleartext)
  - `verifyPasscode(plaintext)` — constant-time compare against current hash
  - All scrypt-hashed at rest (mirror `src/class-login-pins.ts` patterns)

- **`src/db/classroom-roster.ts`** — add `markEnrolled(email, sessionId)`, `resetEnrollment(email)`, `isEnrolled(email): boolean` helpers.

- **`src/channels/playground/api/enrollment.ts`** — new handlers:
  - `handleGetClassPasscode(session)` — owner/admin only. Returns `{ passcode: '4729', createdAt: '...' }` or `{ passcode: null }` if never rotated.
  - `handleRotateClassPasscode(session)` — owner/admin only. Calls `rotatePasscode`. Returns the new cleartext.
  - `handleEnroll({ email, passcode })` — public. Validates passcode + roster + first-come-first-served. On success: mints session for the roster row's user_id, returns 200 + Set-Cookie. On failure: 401 generic.

- **`src/channels/playground/server.ts`** — wire the three new routes inside `handleRequest`.

### Frontend (lands on `main` for trunk + `classroom-x7-provider-auth` for prod's installed UI)

- **`src/channels/playground/public/login.html`** — rewrite. Primary form: email + passcode → POST `/login/enroll`. Secondary text: "Instructor? Send `/playground` on Telegram." Keep `<details>` "Lost your link?" recovery as-is.

- **`src/channels/playground/public/login.js`** — new small client script for the form submit (intercept submit, POST, handle redirect on success / show error on failure). Or inline in login.html.

- **`src/channels/playground/public/tabs/home.js`** — new card for owner/admin: "Today's enrollment passcode" with cleartext + [Rotate] button. Sentinel-bounded so it can install/uninstall cleanly. Lands on both `main`'s home.js AND `classroom-x7-provider-auth`'s home.js (the latter is what prod has on disk).

### Tests

- `src/class-enrollment-passcode.test.ts` — rotate produces fresh code, verify accepts current and rejects old, scrypt format
- `src/channels/playground/api/enrollment.test.ts` — handler tests with mocked storage
- Updates to `src/db/classroom-roster.test.ts` — markEnrolled/resetEnrollment/isEnrolled

## Out of scope (v1)

- Per-student passcode reset UI (use `ncl roster reset-enrollment <email>` or `scripts/q.ts` SQL for now)
- Multi-class (one passcode globally; class_id seam in X.7 not exercised here)
- Auto-rotation on schedule (manual rotate only)
- Audit log of enrollments (just the roster column; full log can come later)
- Resetting `enrolled_at` from inside the playground UI (instructor uses CLI for now)

## Deploy

1. Commit + push main.
2. Mirror Home-card change to `classroom-x7-provider-auth` branch + push.
3. On prod worktree: pull main, overwrite prod's home.js from classroom branch.
4. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4` to restart.
5. Smoke test: owner signs in via Telegram /playground → Home card shows "—" passcode → click Rotate → 4-digit code appears → log out → sign in as a test student via email+passcode → verify session works.
