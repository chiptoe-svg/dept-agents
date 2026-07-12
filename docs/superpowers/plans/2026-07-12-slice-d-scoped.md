# Slice D (scoped) — Drop `classroom_roster` + Department Vocabulary

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the vestigial, empty `classroom_roster` table (rewiring its remaining email-lookup consumers to the `agent_groups.metadata` email that provisioned users actually carry) and replace the user-visible "instructor" wording with department-appropriate copy.

**Architecture:** The roster is 0 rows and provisioned users' emails live in `agent_groups.metadata` (`{"email":"…"}`); the metadata lookup is already the only path that resolves anyone. So this is a safe rewire (no behavior change) plus a `DROP TABLE` migration, followed by a text-only vocabulary pass over rendered strings. Internal identifiers (`class_login_tokens`/`class_telegram_pair_codes` tables, the `class-tokens` CLI name, `student-*` modules, the `ta` role) are **deliberately left as-is** — renaming live-data tables is churn with breakage risk and no functional gain.

**Tech Stack:** Node/pnpm host, TypeScript, `better-sqlite3` central DB with numbered migrations (`src/db/migrations/`), vitest. Playground frontend is vanilla ES modules.

## Global Constraints

- **No behavior change from the rewire.** After Task 1, every path that previously resolved an email→user via `classroom_roster` must resolve the same real users via `agent_groups.metadata` (provisioned users). Since the roster is empty, this preserves current behavior and fixes the (already-dead) token→email lookup.
- **Do NOT rename or migrate** `class_login_tokens`, `class_login_pins`, `class_telegram_pair_codes` (they hold live data), the `class-tokens` CLI resource, the `student-*` modules, or the `ta` role. Out of scope.
- **Migration discipline:** never edit an applied migration (016 created the roster — leave it). Add a NEW migration `025-drop-classroom-roster.ts` that `DROP TABLE IF EXISTS classroom_roster`. Its `version` = the next integer after the current highest migration version (live DB is at schema_version 25 → new version is **26**). Register it in `src/db/migrations/index.ts` (import + append to the `migrations` array, in file-number order).
- **Vocabulary pass is text-only** — change rendered user-visible strings, not variable names, type names (`'class-pool'` source stays), or the `class-controls`/`class-pool` internal concepts.
- Host build/test: `pnpm run build` clean and `pnpm test` green before a task is done (run them yourself). Clean any stray `groups/` fixture dirs your run creates (leave `_default_participant`, `owner_01`).
- Commit messages end (after a blank line) with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WXUAU8TQduy8SMSVWoNYvn
  ```

---

## File Structure

- **Create `src/user-email-lookup.ts`** — shared metadata-email resolvers used by every ex-roster consumer: `resolveUserIdByEmail(email)` and `emailForUserId(userId)`. One responsibility: map between a user and the email stored in their agent group's metadata.
- **Create `src/user-email-lookup.test.ts`** — unit tests for both resolvers.
- **Modify `src/class-login-tokens.ts`** — `resolveUserIdByEmail` (lost-link recovery) and the PIN `registerTokenLookup` join now use the shared metadata resolvers; drop `classroom_roster` from both.
- **Modify `src/cli/resources/class-tokens.ts`** — `resolveTokenUser` and `list-for` use the shared `resolveUserIdByEmail`; delete the local roster `resolveUserIdByEmail`; update error text + help strings to drop "classroom_roster" mentions.
- **Create `src/db/migrations/025-drop-classroom-roster.ts`** + register in `src/db/migrations/index.ts` — drop the table.
- **Modify** the user-visible "instructor" strings (Task 2): `src/channels/playground/public/login-pin.html`, `src/channels/playground/public/tabs/home.js`, `src/channels/playground/api/models-tab-state.ts`, `src/channels/playground/api/google-auth.ts`.
- **Create `docs/superpowers/reviews/2026-07-12-slice-d-verification.md`** (Task 3).

---

### Task 1: Rewire ex-roster consumers to metadata email + drop the table

**Files:**
- Create: `src/user-email-lookup.ts`, `src/user-email-lookup.test.ts`
- Modify: `src/class-login-tokens.ts` (`resolveUserIdByEmail` ~line 153; the `registerTokenLookup` join ~line 224-233), `src/cli/resources/class-tokens.ts` (`resolveUserIdByEmail` ~line 11, `resolveTokenUser` ~line 55, the `list-for` handler, help/error text)
- Create: `src/db/migrations/025-drop-classroom-roster.ts`; Modify: `src/db/migrations/index.ts`

**Interfaces:**
- Produces (in `src/user-email-lookup.ts`):
  - `resolveUserIdByEmail(email: string): string | null` — find the agent group whose `metadata.$.email` matches (case-insensitive), return that group's member `user_id` (or a user with a role scoped to that group). This is the existing `resolveUserIdByMetadataEmail` logic from `class-tokens.ts`, moved here verbatim.
  - `emailForUserId(userId: string): string | null` — the reverse: the email in the metadata of the agent group this user belongs to (member first, else scoped-role group). Returns null if none.

- [ ] **Step 1: Write the failing tests**

Create `src/user-email-lookup.test.ts`. Use the project's existing DB-test harness (look at `src/cli/resources/class-tokens.test.ts` or `src/provisioning/provision-user.test.ts` for how they build a temp central DB + run migrations + seed rows). Seed one agent group with `metadata='{"email":"dana@clemson.edu"}'` and a member `playground:dana`, then:

```ts
import { describe, it, expect } from 'vitest';
// + the project's test-db setup (mirror provision-user.test.ts)
import { resolveUserIdByEmail, emailForUserId } from './user-email-lookup.js';

describe('user-email-lookup (metadata-based)', () => {
  it('resolves a user id from the group metadata email (case-insensitive)', () => {
    // seed group metadata email dana@clemson.edu + member playground:dana
    expect(resolveUserIdByEmail('DANA@clemson.edu')).toBe('playground:dana');
    expect(resolveUserIdByEmail('nobody@clemson.edu')).toBeNull();
  });
  it('resolves the email for a user id (reverse)', () => {
    expect(emailForUserId('playground:dana')).toBe('dana@clemson.edu');
    expect(emailForUserId('playground:ghost')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/user-email-lookup.test.ts`
Expected: FAIL — `Cannot find module './user-email-lookup.js'`.

- [ ] **Step 3: Implement `src/user-email-lookup.ts`**

Move the metadata-email logic out of `class-tokens.ts` into the shared module (this is the existing `resolveUserIdByMetadataEmail` body, plus the reverse):

```ts
/**
 * Resolve between a user and the email stored in their agent group's
 * metadata (`{"email":"…"}`, written by `ncl users provision`). This is
 * the department replacement for the old `classroom_roster` email table.
 */
import { getDb } from './db/connection.js';

export function resolveUserIdByEmail(email: string): string | null {
  const group = getDb()
    .prepare("SELECT id FROM agent_groups WHERE LOWER(json_extract(metadata, '$.email')) = LOWER(?)")
    .get(email) as { id: string } | undefined;
  if (!group) return null;
  const member = getDb()
    .prepare('SELECT user_id FROM agent_group_members WHERE agent_group_id = ? LIMIT 1')
    .get(group.id) as { user_id: string } | undefined;
  if (member) return member.user_id;
  const scopedRole = getDb()
    .prepare('SELECT user_id FROM user_roles WHERE agent_group_id = ? LIMIT 1')
    .get(group.id) as { user_id: string } | undefined;
  return scopedRole?.user_id ?? null;
}

export function emailForUserId(userId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT json_extract(g.metadata, '$.email') AS email
       FROM agent_group_members m
       JOIN agent_groups g ON g.id = m.agent_group_id
       WHERE m.user_id = ?
       LIMIT 1`,
    )
    .get(userId) as { email: string | null } | undefined;
  return row?.email ?? null;
}
```

> Verify the `getDb` import path matches how other `src/*.ts` files import it (grep `from './db/connection.js'` vs `from './db.js'` — use whatever the neighbors use).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/user-email-lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `class-login-tokens.ts`**

1. Replace the body of `resolveUserIdByEmail` (the roster query, ~line 153) with a call to the shared one:
   ```ts
   import { resolveUserIdByEmail, emailForUserId } from './user-email-lookup.js';
   // …delete the local roster-based resolveUserIdByEmail; use the imported one.
   ```
   (If the local function name collides, delete the local and use the import directly at the call sites.)
2. Replace the PIN `registerTokenLookup` join (~line 224-233) so it does NOT reference `classroom_roster`:
   ```ts
   registerTokenLookup((token) => {
     const row = getDb()
       .prepare('SELECT user_id FROM class_login_tokens WHERE token = ? AND revoked_at IS NULL')
       .get(token) as { user_id: string } | undefined;
     if (!row) return null;
     const email = emailForUserId(row.user_id);
     return email ? { userId: row.user_id, email } : null;
   });
   ```
3. Update the comment that says "Looks them up in `classroom_roster`" / "the same classroom_roster join" to describe the metadata lookup.

- [ ] **Step 6: Rewire `cli/resources/class-tokens.ts`**

1. Delete the local `resolveUserIdByEmail` (roster query) and import the shared one: `import { resolveUserIdByEmail } from '../../user-email-lookup.js';`. Delete the now-duplicate `resolveUserIdByMetadataEmail` (its logic now lives in the shared module) and update `resolveTokenUser` to `const userId = resolveUserIdByEmail(email);`.
2. Update the `resolveTokenUser` error text to drop "classroom_roster": `No user found for email ${email} (no agent group with that metadata email)`.
3. Update the `list-for` handler if it queries `classroom_roster` — make it resolve via `resolveUserIdByEmail` then list that user's tokens. (Read the current `list-for` body; if it can't be cleanly metadata-ified, list by the resolved user_id.)
4. Update the help/description strings that mention "classroom_roster" / "roster" / "student" to department wording (e.g. "resolved via the agent group's metadata email").

- [ ] **Step 7: Confirm no code references `classroom_roster` remain**

Run: `grep -rIn "classroom_roster" src/ | grep -v "016-classroom-roster\|025-drop-classroom-roster"`
Expected: no matches (comments included — scrub any stragglers in `pi.ts`, `default-participant.ts`, `class-login-pins.ts`).

- [ ] **Step 8: Create the drop migration**

Create `src/db/migrations/025-drop-classroom-roster.ts` (mirror the shape of `024-backstop-usage.ts`):

```ts
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 26,
  name: 'drop-classroom-roster',
  up: (db) => {
    db.exec('DROP TABLE IF EXISTS classroom_roster;');
  },
};
```

> Confirm `version: 26` is exactly one past the current highest migration version. Check `024-backstop-usage.ts`'s `version` (it should be 25, matching the live schema_version); if the numbering differs, set this to `<that> + 1`.

Register in `src/db/migrations/index.ts`: add `import { migration025 } from './025-drop-classroom-roster.js';` with the other numbered imports, and append `migration025` to the `migrations` array after `migration024`.

- [ ] **Step 9: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green. If `class-tokens.test.ts` or a migration/schema test asserted `classroom_roster` existence or the old error text, update those assertions to the metadata behavior.

- [ ] **Step 10: Commit**

```bash
git add src/user-email-lookup.ts src/user-email-lookup.test.ts src/class-login-tokens.ts src/cli/resources/class-tokens.ts src/db/migrations/025-drop-classroom-roster.ts src/db/migrations/index.ts
git add -u src/  # picks up any comment scrubs in pi.ts / default-participant.ts / class-login-pins.ts
git commit -m "refactor: drop vestigial classroom_roster; resolve email via agent-group metadata"
```

---

### Task 2: Department vocabulary (user-visible "instructor" → admin/department)

**Files (rendered strings only):**
- Modify: `src/channels/playground/public/login-pin.html`, `src/channels/playground/public/tabs/home.js`, `src/channels/playground/api/models-tab-state.ts`, `src/channels/playground/api/google-auth.ts`

**Interfaces:** none (text changes).

- [ ] **Step 1: Update the failing test first (models-tab-state)**

The models-tab greying function returns `actionLabel: 'ask instructor'` (`models-tab-state.ts:90`); its test asserts that string. Change the expectation to `'ask admin'`:

Find the assertion in `src/channels/playground/api/models-tab-state.test.ts` (search `ask instructor`) and change it to `'ask admin'`. Run it to see it fail against the current source.

Run: `pnpm exec vitest run src/channels/playground/api/models-tab-state.test.ts`
Expected: FAIL (source still returns 'ask instructor').

- [ ] **Step 2: Apply the vocabulary changes**

Make these exact rendered-string replacements (leave comments, type names, and variable names alone):

- `src/channels/playground/api/models-tab-state.ts:90` — `actionLabel: 'ask instructor'` → `actionLabel: 'ask admin'`.
- `src/channels/playground/public/login-pin.html:68` — `'Could not start sign-in. Ask your instructor for a fresh link.'` → `'Could not start sign-in. Ask your admin for a fresh link.'`
- `src/channels/playground/public/tabs/home.js:54` — `(class instructor)` → `(admin)`.
- `src/channels/playground/public/tabs/home.js:422` — `The instructor hasn't configured the Telegram bot yet, so pairing is unavailable.` → `The admin hasn't configured the Telegram bot yet, so pairing is unavailable.`
- `src/channels/playground/public/tabs/home.js:480` — `…use YOUR Google Drive instead of the instructor's shared one. Disconnect to revert to the class-shared Drive.` → `…use YOUR Google Drive instead of the department's shared one. Disconnect to revert to the shared department Drive.`
- `src/channels/playground/public/tabs/home.js:498` — `…operates against YOUR Drive (not the instructor's). Optional — until you connect, Drive tools work via the shared class-Drive (Mode A)…` → `…operates against YOUR Drive (not the department's). Optional — until you connect, Drive tools work via the shared department Drive (Mode A)…`
- `src/channels/playground/public/tabs/home.js:742` — `'Provided by instructor'` → `'Provided by the department'`.
- `src/channels/playground/public/tabs/home.js:756` — `Provided by instructor` → `Provided by the department`.
- `src/channels/playground/api/google-auth.ts:132` — `The instructor needs to run /add-classroom-gws so the OAuth client is on disk.` → `The admin needs to run /add-classroom-gws so the OAuth client is on disk.`

> Do NOT touch the docstring at `models-tab-state.ts:13` truth-table comment, `provider-groups.js`/`style.css` comments, `usage.ts:206` comment, or any `'class-pool'` / `class-controls` type/identifier — those are internal, not user-visible.

- [ ] **Step 3: Run the models-tab test to verify it passes**

Run: `pnpm exec vitest run src/channels/playground/api/models-tab-state.test.ts`
Expected: PASS.

- [ ] **Step 4: Confirm no user-visible "instructor" rendered strings remain**

Run: `grep -rInE ">[^<]*instructor|'[^']*instructor|\"[^\"]*instructor" src/channels/playground/public/ src/channels/playground/api/ | grep -ivE "// |^\s*\*|\.test\."`
Expected: no rendered-string matches (only comments/type refs, if any).

- [ ] **Step 5: Full build + test**

Run: `pnpm run build && pnpm test`
Expected: tsc clean; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/login-pin.html src/channels/playground/public/tabs/home.js src/channels/playground/api/models-tab-state.ts src/channels/playground/api/models-tab-state.test.ts src/channels/playground/api/google-auth.ts
git commit -m "chore(copy): department vocabulary — user-visible 'instructor' -> admin/department"
```

---

### Task 3: Live verification

**Files:** Create `docs/superpowers/reviews/2026-07-12-slice-d-verification.md`. Service label: `com.nanoclaw-v2-581fefa4`.

- [ ] **Step 1: Rebuild + restart** (`pnpm run build` then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-581fefa4`).

- [ ] **Step 2: Migration applied, table gone**

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT MAX(version) FROM schema_version;"          # expect 26
pnpm exec tsx scripts/q.ts data/v2.db "SELECT name FROM sqlite_master WHERE name='classroom_roster';"  # expect empty
```

- [ ] **Step 3: Email resolution still works via metadata**

`./bin/ncl class-tokens rotate --email chiptoe@mac.com` (the owner's provisioned email, or whatever email is in `owner_01`'s `agent_groups.metadata`) → confirm it resolves to `playground:owner_01` and prints a URL. If the owner group has no metadata email, provision a throwaway member with a known email, rotate `--email` it, confirm resolution, then delete it. Also confirm `--user-id playground:owner_01` still works (direct path, unaffected).

- [ ] **Step 4: Owner login still works** — the `class_login_tokens` table (untouched) still holds the owner's tokens; redeem one (or the freshly-rotated URL) and confirm `GET /api/me/agent` returns the owner. This proves dropping the roster didn't disturb the live login-token table.

- [ ] **Step 5: Vocabulary check** — `curl` the served `login-pin.html` and confirm "Ask your admin for a fresh link"; spot-check the owner Home tab strings no longer say "instructor".

- [ ] **Step 6: Write the verification doc + commit.**

---

## Self-Review

**1. Spec coverage:** drop `classroom_roster` (Task 1, migration 025 + consumer rewire); user-visible instructor vocab (Task 2); live proof incl. migration + email resolution + owner login intact (Task 3). Internal table/module/role renames explicitly out of scope (stated in Global Constraints).

**2. Placeholder scan:** no TBD/TODO; the two "read the current body / mirror the harness" notes (list-for, test setup) point at concrete existing code to copy, not invented content.

**3. Type consistency:** `resolveUserIdByEmail(email): string|null` and `emailForUserId(userId): string|null` are defined in `user-email-lookup.ts` and consumed with those exact signatures in `class-login-tokens.ts` and `class-tokens.ts`; migration `version: 26` matches the "next after 25" rule; the `Migration` interface import matches `024-backstop-usage.ts`.
