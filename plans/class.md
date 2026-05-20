# Class feature — 16-student bot provisioning

Provision an instructor-owned NanoClaw bot that hosts N (default 16) student
agent groups on a single Telegram bot identity. Each student gets their own
agent group, DM, persona, Drive folder, and shared KB + wiki access. The
instructor stays global owner across all 16.

> **Status:** Phases 1 + 2 + 3a shipped (`3cc4e4e`, `273d92c`, `6248293`).
> Phase 2's service-account assumptions reverted in `f790913` ahead of an
> OAuth-based 3b. Phase 3b in progress (uncommitted: `src/class-drive.ts`,
> telegram pairing call, `googleapis` dep). Update phase checkboxes as work
> lands.

## Source-of-truth artifacts

- `docs/class-setup.md` — instructor-facing README (what the instructor does
  in GCP + on the host before running the script)
- `scripts/class-skeleton.ts` — bulk provisioner (Phase 1 deliverable)
- `data/class-config.json` — written by the skeleton script, read by the
  pair handler in Phase 3 (`driveParent`, `kb`, `wiki`, `students[]`)
- `class-roster.csv` — written by the skeleton script for distribution

## Phases

### Phase 1 — Skeleton script + instructor README ✅ (commit `3cc4e4e`)

- [x] `docs/class-setup.md` — instructor README covering service-account
      setup, parent Drive folder, KB dir, wiki git init, distribution flow
- [x] `scripts/class-skeleton.ts`:
    - [x] `--count`, `--names`, `--drive-parent`, `--kb`, `--wiki` CLI args
    - [x] Persists `data/class-config.json` for later phases
    - [x] Idempotent: skips existing `agent_groups` rows by folder
    - [x] Creates `groups/student_<n>/` with `CLAUDE.md` + `CLAUDE.local.md`
          + `container.json`
    - [x] `additionalMounts` for KB (ro) and wiki (rw) recorded in
          `container.json`
    - [x] Generates `wire-to` pairing code per student via `createPairing`
    - [x] Writes `class-roster.csv` for instructor distribution

### Phase 2 — per-group container env infra ✅ (commit `6248293` + revert `f790913`)

Original scope was "install `@googleworkspace/cli` + mount a service-account
JSON into student containers." `f790913` walked back the service-account
parts because the instructor already has working user-OAuth at
`~/.config/gws/` (drive/docs/sheets/slides/gmail scopes, refresh token), so
(a) the auth model was wrong and (b) Drive ops belong host-side, not in the
container. What stays from Phase 2:

- [x] `ContainerConfig.env: Record<string,string>` field, threaded through
      `container-runner.buildContainerArgs` so per-group env vars get
      injected at spawn. Keeping this — useful for any per-group env need.

What was reverted (do **not** redo):

- [x] ~~`@googleworkspace/cli` Dockerfile install~~ — Drive ops moved to host.
- [x] ~~`--drive-creds` CLI flag + service-account mount + `GOOGLE_APPLICATION_CREDENTIALS`~~
      — replaced by Phase 3b's host-side OAuth path.

### Phase 3a — Pair handler: `<code> <email>` + wire-to dispatch ✅

**Surprise during implementation:** the `wire-to` pairing intent had no
handler before this phase. The `class-skeleton` script (Phase 1) generated
codes that, when consumed, registered the chat + paired user but never
wired the messaging group to its target agent group. Phase 3a fixed that.

- [x] `extractCode` / new `extractCodeAndEmail` accept either a bare 4-digit
      code OR `<code> <email>` (loose RFC-shape email regex). Existing
      "0349 thanks" rejection preserved.
- [x] `tryConsume` captures the email and stores it on
      `PairingRecord.consumed.email`.
- [x] Migration 015 adds `agent_groups.metadata TEXT` (nullable JSON blob).
      `getAgentGroupMetadata(id)` / `setAgentGroupMetadataKey(id, key, value)`
      helpers. `AgentGroup.metadata` is optional on the type so existing
      literal constructions don't need a migration of their own.
- [x] `src/class-config.ts` reads `data/class-config.json`,
      `findClassStudent(folder)` lookup helper.
- [x] Telegram pairing interceptor now handles `wire-to`:
      looks up `agent_group` by folder, creates `messaging_group_agents`
      row with `init-first-agent`-style defaults (engage-pattern '.' for DMs,
      mention-only for groups), persists `student_email` + `student_name`
      on the agent group's metadata when the folder is in `class-config`.
- [x] Tests added for the new email-extraction paths; full suite
      (312 / 312) green.

### Phase 3b — Drive folder creation on pair (in progress, uncommitted)

Auth model: instructor's existing user-OAuth at
`~/.config/gws/credentials.json` (left behind by `taylorwilsdon/google_workspace_mcp`
via `/add-gmail-tool` / `/add-gcal-tool`). Host-side only — the refresh
token is full-Drive scope, so we don't expose it to containers.

- [x] `src/class-drive.ts`: loads `~/.config/gws/credentials.json`, builds
      a `googleapis` Drive v3 client with refresh-token auth, exports
      `createStudentFolder({ parentFolderId, studentFolder, studentName,
      studentEmail })` → `{ folderId, folderUrl, created, shared }`.
      Idempotent on both axes (folder lookup by name under parent;
      permission check before re-granting). `sendNotificationEmail: false`
      so Google's notice doesn't race the bot's welcome DM.
- [x] `package.json`: add `googleapis@171.4.0` (released 2026-02-05, well
      past `minimumReleaseAge: 4320`).
- [x] Pair interceptor (`src/channels/telegram.ts`): after persisting
      `student_email` + `student_name`, look up class config + agent
      group metadata; if email is captured, `driveParent` is configured,
      and no `drive_folder_id` is already set, call `createStudentFolder`
      inline, then `setAgentGroupMetadataKey` for `drive_folder_id` +
      `drive_folder_url`. Drive errors are logged but don't fail pairing.
- [x] Decision: inline (not background). Drive call happens before pairing
      confirmation so the welcome message can include the folder URL.
      Re-pair retries on failure.
- [x] `pnpm exec tsc --noEmit` clean. `pnpm test` 312/312 green.
- [ ] Manual verification with the instructor's real OAuth + a throwaway
      parent folder (deferred to Phase 7 smoke test).
- [ ] Commit `src/class-drive.ts` + telegram.ts diff + package.json +
      pnpm-lock.yaml (waiting on user signoff).

### Phase 3c — rclone mount + Doc-only MCP (next)

**Architectural decision.** A general "Drive MCP" (list/read/write) duplicates
what bash + a real filesystem already do, and it duplicates them *worse* —
extra tool-roster weight, extra latency, extra auth surface, no semantic
gain. Codex (the agent provider this install runs most of the time) is
bash-first by design; wrapping `cat`/`ls`/`grep -r` in MCP makes Codex worse
at being Codex. So:

1. **rclone-mount the student's specific Drive subfolder** at
   `/workspace/drive/` inside the container. The instructor's full-Drive
   OAuth stays on the host; the container only sees one folder via bind
   mount. Codex uses bash, Claude uses Read/Write/Grep — both work because
   it's a real path.
2. **Doc-only MCP** for the one thing rclone can't do: Google Docs are
   pointer files in rclone, not text. Two tools, host-side, scoped per
   agent group: `drive_doc_read_as_markdown(name)`,
   `drive_doc_write_from_markdown(name, markdown)`. Anything else (list,
   move, upload, search by content) goes through the rclone mount.

**Why one rclone process for the class, not 16.** rclone supports
`--drive-root-folder-id <PARENT>` to anchor the visible tree at the class
parent folder. One mount, one fuse process; each student's container
bind-mounts only its own subfolder by name.

**3c.1 — rclone host-side mount (instructor-run, one-time)**

- [ ] `docs/class-setup.md`: install `rclone`, `rclone config` to create a
      remote (call it `class-drive`) reusing the existing OAuth at
      `~/.config/gws/credentials.json` if rclone can be pointed at it; if
      not, walk through `rclone authorize drive` for a fresh refresh
      token. Set `--drive-root-folder-id <classConfig.driveParent>` on
      the remote.
- [ ] Systemd user unit (`docs/class-setup.md` snippet):
      `rclone mount class-drive: ~/nanoclaw-drive-mount/
       --vfs-cache-mode writes --dir-cache-time 30s
       --poll-interval 15s` so newly-created student folders show up
      promptly after Phase 3b runs.
- [ ] Add `~/nanoclaw-drive-mount/` (recursive) to the mount allowlist at
      `~/.config/nanoclaw/mount-allowlist.json`.

**3c.2 — per-student bind mount in class-skeleton**

- [ ] Folder name on disk under the rclone view is
      `<studentFolder> — <studentName>` (em dash, matches
      `createStudentFolder` in `src/class-drive.ts`). class-skeleton
      knows both at provision time, so write the mount into
      `container.json` at skeleton time — no pair-time mutation needed:
      ```
      { "hostPath": "<HOME>/nanoclaw-drive-mount/<folder> — <name>",
        "containerPath": "/workspace/drive", "readonly": false }
      ```
- [ ] New `--drive-mount-root` CLI flag (default `~/nanoclaw-drive-mount`)
      so non-default rclone mount paths work.
- [ ] Idempotent: re-running skeleton with new flags rewrites
      container.json mounts.

**3c.3 — Doc-only MCP server (after 3c.1+3c.2 prove rclone path works)**

- [ ] Two tools only: `drive_doc_read_as_markdown`,
      `drive_doc_write_from_markdown`.
- [ ] Host-side server, single process, authenticates the caller by an
      agent-group token injected into container env at spawn (mirror the
      credential-proxy pattern). Server looks up `drive_folder_id` from
      `agent_groups.metadata`; all Doc operations are scoped to that
      folder's children.
- [ ] Wire into `mcpServers` in the student's `container.json` only when
      `drive_folder_id` is present on the agent group's metadata.
- [ ] Skip if the rclone mount + Codex's bash + the agent's existing
      ability to use the Drive UI cover the actual use cases. Reassess
      after Phase 7 smoke test.

**Explicitly NOT building (rejected):**
- ~~General-purpose Drive MCP (list/read/write/grep)~~ — duplicates the
  filesystem rclone gives us, makes Codex worse.
- ~~Read/Write/Edit/Grep MCP "for Codex"~~ — Codex is bash-first by
  intent; `apply_patch` + shell already cover this. MCP wrappers add
  prompt overhead with no functional gain. The win for MCPs is things
  bash *can't* do.

### Phase 4 — Per-student git identity for wiki attribution ✅

Pair-time captures already give us the real student identity
(`agent_groups.metadata.student_name` from class config + `student_email`
from the `<code> <email>` pairing). Inject those as
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars at container spawn — better
than the original synthetic `student_07@class.local` plan because
`git log` shows actual humans the instructor recognizes.

- [x] `gitAuthorEnvFromMetadata(metadata)` pure helper in
      `src/container-runner.ts`. Emits 4 env pairs only when **both**
      name and email are present and non-empty (whitespace trimmed,
      non-string values ignored). Partial attribution would be worse
      than git's default error.
- [x] `buildContainerArgs`: looks up `getAgentGroupMetadata(agentGroup.id)`
      at spawn, pushes the env pairs through. No-op for non-class
      groups (empty metadata → empty array).
- [x] 7 unit tests covering present, missing-name, missing-email,
      empty metadata, whitespace-only, trimming, defensive non-string.
- [x] `pnpm exec tsc --noEmit` clean, 319/319 tests green.
- [ ] End-to-end verify deferred to Phase 7: a real wiki commit from
      Alice's container should show `Alice Chen <alice@school.edu>`
      in `git log`.

### Phase 5 — Scoped playground ✅

Per-agent-group scoping was already in place via magic-link auth, so the
audit step was a no-op. The actual lockdown is server-side gating on the
draft mutation endpoints — return 403 from the file PUT, skills PUT, and
provider PUT when the draft's target is a provisioned class student.
The persona endpoint (`PUT /api/drafts/:folder/persona`, used by the
"Edit Persona" pane) stays open. Students customize personality;
instructor controls everything else.

- [x] `isClassStudentFolder(folder)` helper in `src/class-config.ts`.
      Tested: present, absent, no class provisioned.
- [x] `isClassStudentDraft(draftFolder)` helper in
      `src/channels/playground.ts` — strips the `draft_` prefix and
      delegates. Returns false (not a security failure) for
      non-draft inputs so existing routes don't change behavior.
- [x] 403 gate on file PUT, skills PUT, provider PUT for class
      drafts. GETs remain open (reading shared CLAUDE.md is fine).
- [x] applyDraft already only copies `CLAUDE.local.md` and
      `container.json` back to the target — even pre-gate, a student
      could not have written a `CLAUDE.md` that escaped to production.
      The container.json PUT path was the actual exposure (skills,
      provider, mounts via the file editor) and is now closed.
- [x] 8 unit tests for the new helper. `pnpm exec tsc --noEmit`
      clean, 327/327 tests green.
- [ ] Class-wide `agent_group_members` row for the instructor — defer.
      Owner role already grants access to every group; this was only
      for audit-log cleanliness.

### Phase 6 — Welcome message + privacy notice ✅

For class flows the generic "Pairing success! I'm spinning up the agent
now…" confirmation is replaced with a tailored welcome: greeting using
the student's display name, the Drive folder URL, the privacy notice,
and a pointer to `/playground`.

- [x] `src/class-welcome.ts` — `getClassWelcomeText({name, driveUrl})`.
      Reads `data/class-welcome.md` if present (instructor override),
      otherwise uses a sensible default. Substitutes `{name}` and
      `{drive_url}`. Empty/missing drive URL renders as "(Drive folder
      pending — check back in a minute)" so a transient Drive error
      doesn't break the welcome message.
- [x] Pair handler captures a `classWelcome` payload inside the wire-to
      block (when target is a class student); after Drive folder
      creation, sends `getClassWelcomeText(classWelcome)` instead of
      the generic confirmation.
- [x] `sendPairingConfirmation` factored to share a `sendTelegramText`
      helper with `disable_web_page_preview: true` (avoids huge Drive
      previews in chat).
- [x] 7 unit tests for `getClassWelcomeText` covering substitution,
      override file precedence, missing/empty drive URL, all-occurrence
      replacement, whitespace-only override, default fallback.
- [x] `pnpm exec tsc --noEmit` clean, 334/334 tests green.

Override path: instructor drops a custom `data/class-welcome.md` next
to `class-config.json` at any time — no restart needed; the file is
read on each pair. Variables `{name}` and `{drive_url}` are the only
substitutions.

### Phase 7 — Verification + end-to-end smoke

Runbook lives at [`plans/class-smoke-test.md`](class-smoke-test.md) —
10-step walkthrough covering pre-flight, provisioning, two student
pairings, drive bind-mount sanity, wiki attribution, playground 403s,
instructor visibility, idempotency, failure-mode spot-checks, and
cleanup. Cannot be auto-run from this seat (needs a real Google
account + bot token + two real Telegram accounts). Run it once
end-to-end before claiming the class feature is shippable, and update
`docs/class-setup.md` with whatever gotchas surface.

### Phase 8 — Bundle as `/setup-class` skill (optional)

- [ ] Wrap Phases 1 + manual setup steps from the README into an
      operational skill so instructors don't read a doc — they run a skill
      that walks through GCP setup, KB/wiki dir creation, then invokes
      `class-skeleton.ts`.
- [ ] Defer until Phases 1–7 are stable.

### Phase 9 — Per-student Codex OAuth via magic link

The school has an OpenAI deal — every student already has a ChatGPT
subscription. Codex CLI's OAuth flow lets that subscription power
agent activities, and the existing `src/providers/codex.ts` already
wires per-session `auth.json` copies for the *instructor*. Per-student
is a one-line change in the provider plus a magic-link upload pipeline.

**Why this works (and why #1 paste-API-key was the wrong shape):**
- Codex OAuth uses a long-lived refresh token. Students do `codex
  login` once on their laptop, get an `auth.json`, paste/upload it
  via a magic link the bot DMs them. Lasts weeks/months.
- Subscription quota goes to the *student's* account — no instructor
  cost-per-student. (As of 2026-05, OpenAI hasn't followed Anthropic's
  Feb 2026 ban on subscription tokens in third-party tools; this is
  what NanoClaw's existing OpenAI provider already relies on.)
- The credential proxy isn't involved on this codepath — Codex reads
  the per-session auth.json directly. So per-student = different
  source path at copy time.

**Data model addition.** Pair handler also stashes
`agent_groups.metadata.student_user_id` (the `telegram:<chatid>` form)
so the codex provider can look up the student's stored auth.json from
the agent group at session spawn.

**Storage:** plain auth.json files at
`data/student-auth/<sanitized_user_id>/auth.json`. No encryption
(matches existing `~/.codex/auth.json` model on disk). Blast radius
is the host filesystem — same as the instructor's auth today.

#### 9.1 — Storage layer (`src/student-auth.ts`)
- [ ] Sanitize user_id (`telegram:12345` → `telegram_12345`) for safe
      filesystem paths. Reject anything outside `[A-Za-z0-9_-]`.
- [ ] `storeStudentAuth(userId, jsonText)` — validates JSON shape
      (must parse, must contain a `tokens` field with at least
      access/refresh tokens, mirror Codex's expected schema), writes
      atomically (temp file + rename).
- [ ] `getStudentAuthPath(userId)` → string | null.
- [ ] `hasStudentAuth(userId)` → boolean.
- [ ] `deleteStudentAuth(userId)` → void (idempotent).
- [ ] Unit tests: shape validation, path traversal rejection,
      idempotent delete, atomic write doesn't leak partial files.

#### 9.2 — Magic-link HTTP server ✅

Built as a dedicated `src/student-auth-server.ts` rather than piling
onto the webhook server — webhook's lifecycle is owned by Chat SDK and
its route conventions don't fit. New always-on server, lazy-started on
first `issueAuthToken` call. Two routes only; everything else 404s.

- [x] In-memory token registry: 30-min TTL, single-use, 192-bit
      tokens. `issueAuthToken(userId)` → token; `buildAuthUrl(token)` →
      full public URL (or null when `NANOCLAW_PUBLIC_URL` is unset,
      so callers can render a fallback message instead of a broken
      localhost link).
- [x] `GET /student-auth?t=<token>` → drag-drop upload page, plain
      HTML + vanilla JS, no framework. Three-step instructions
      ("install codex, codex login, drop your auth.json"). Drop-zone
      AND a paste-into-textarea fallback for students who can't
      drag from their file manager.
- [x] `POST /student-auth/upload?t=<token>` — JSON body
      `{ authJson: "..." }`, validates via storage layer, returns
      `{ ok: true }`. Token consumed on first POST regardless of
      shape-validation outcome (single-use).
- [x] Config: `STUDENT_AUTH_PORT` (default 3003), `STUDENT_AUTH_BIND_HOST`
      (default 0.0.0.0), `NANOCLAW_PUBLIC_URL` (no default — required
      for off-LAN class deployments).
- [x] 14 integration tests via real http.Server on an OS-assigned
      port (test hooks `_getBoundPortForTest` + `_waitForListeningForTest`):
      valid GET, bad-token GET, single-use enforcement, JSON shape
      rejection, malformed body, unknown route. tsc + 368/368 green.
- [ ] `docs/class-setup.md`: tunneling/public-URL guidance — left
      for 9.4 since that's where the welcome message refers to the
      auth link and we'll surface the deploy story together.

#### 9.3 — Codex provider per-student source lookup ✅

- [x] Extracted `resolveCodexAuthSource({agentGroupId, hostHome})` in
      `src/providers/codex.ts` — pure-ish (filesystem reads only),
      testable. Returns `{ source: 'student' | 'instructor' | 'none',
      path: string | null }`.
- [x] Lookup order: `agent_groups.metadata.student_user_id` →
      `getStudentAuthPath(userId)`; if missing, fall back to
      `<hostHome>/.codex/auth.json`; if still missing, "none" (codex
      will surface an auth-required error to the agent).
- [x] Defensive: non-string `student_user_id` is treated as absent
      (so a stray boolean/number on metadata doesn't break the
      fallback path).
- [x] 7 unit tests using real DB + tmp DATA_DIR + tmp HOME: covers
      none, instructor-only, student-overrides-instructor,
      student-set-but-not-uploaded → fallback, non-string defensive,
      hostHome-undefined cases. tsc clean, 375/375 green.

#### 9.4 — `/login` command + welcome integration ✅

- [x] `/login` Telegram handler in the attachment-interceptor block
      (alongside `/auth`, `/model`, `/playground`). Issues a fresh
      magic-link token for the message author, builds the URL via
      9.2, DMs it. Idempotent — students can re-issue any time.
      Surfaces "ask your instructor" reply when NANOCLAW_PUBLIC_URL
      isn't set rather than a broken localhost URL.
- [x] Pair handler: stamps `student_user_id` on agent group
      metadata (the `pairedUserId` already in scope), so 9.3's codex
      provider lookup has the key it needs.
- [x] Class welcome template grew an `{auth_url}` placeholder.
      Default template gets a third orientation bullet pointing at
      the link, with a "Send /login any time" reminder. Pair handler
      issues a fresh token at welcome-send time and substitutes.
- [x] Empty/null authUrl falls back to "(ask your instructor for the
      auth link — NANOCLAW_PUBLIC_URL isn't configured)" so a
      partial deploy still produces a readable welcome.
- [x] 4 additional welcome unit tests (auth_url substitution, null
      fallback, empty fallback, custom override file with
      auth_url). 379/379 green, tsc clean.

#### 9.5 — Refresh-failure re-auth nudge ✅ (host-side complete; container detection best-effort pending Phase 7 calibration)

- [x] Host: `src/student-auth-handlers.ts` registers a delivery
      action for `request_reauth`. Looks up the agent group's
      `student_user_id` from metadata, issues a fresh magic-link
      token, builds the URL, and delivers a chat DM to the
      student's messaging group via the active channel adapter.
      Falls back to "ask your instructor" when
      NANOCLAW_PUBLIC_URL is unset. Imported from `src/index.ts`
      so the registration fires at host boot.
- [x] Container: `container/agent-runner/src/auth-nudge.ts` exposes
      `looksLikeAuthFailure(message)` (defensive regex covering
      OAuth invalid_grant, 401, "authentication failed", "token
      expired", "invalid token") and `requestReauth(reason)` which
      writes the `{kind: 'system', action: 'request_reauth',
      reason}` outbound row. 5-minute debounce per session so a
      cascading-error storm doesn't spam the student.
- [x] 8 unit tests in `auth-nudge.test.ts` (bun:test) covering the
      regex matches and non-matches.
- [ ] Wire actual call sites in the codex provider's error path —
      deferred to Phase 7 smoke test where we can observe real
      error patterns from the app-server. The helper exists; the
      detector regex is best-effort; call-site wiring is the part
      that benefits from real-world calibration.

**Net:** the entire chain plumbing is ready. As soon as we observe
an actual Codex refresh-failure pattern in Phase 7, we add a single
`if (looksLikeAuthFailure(err.message)) requestReauth(err.message);`
call in the right place.

#### 9.6 — Tests + smoke ✅

- [x] 20 unit tests for 9.1 (storage), 14 for 9.2 (HTTP server),
      7 for 9.3 (provider source resolver), 4 added for 9.4
      (auth_url substitution), 8 for 9.5 (auth-failure regex on
      container side).
- [x] `pnpm exec tsc --noEmit` clean. Host: 379/379 green.
      Container: 73/73 green via `bun test`.
- [ ] Manual end-to-end as part of Phase 7 smoke test:
    - Student receives auth link in welcome.
    - Student does `codex login` locally, uploads auth.json via the
      magic-link page.
    - Codex provider for that student's session uses the student's
      auth.json (verify via log line `codex provider: auth source
      resolved` with `source: "student"`).
    - Subsequent agent activity draws from the student's ChatGPT
      quota.
- [ ] Update `plans/class-smoke-test.md` Phase 7 runbook with the
      Phase 9 verification steps (auth link click → upload → log
      line → quota observation).

### Phase 10 — Retroactive modularity

**Why this exists.** NanoClaw's whole architecture is registry-based
extension points (`registerChannelAdapter`, `registerProviderContainerConfig`,
`registerDeliveryAction`, `onDeliveryAdapterReady`). Phases 1–9
violated that pattern by adding inline `if (findClassStudent(folder))`
hooks into five shared core files. That makes `main` carry
class-specific code paths even when no class is provisioned, and it
blocks Phase 8's "extract to a sibling branch + install skill"
trajectory because the inline hooks don't have a clean removal seam.

**This phase fixes that retroactively.** Each extraction is a small
registry (~20–30 lines) plus migrating the class implementation to
register against it. After Phase 10, `main` is class-agnostic again
and Phase 8 packaging becomes mechanical.

**Constraint**: tests must stay green at every step. Each substep is
its own commit so any regression is bisectable. The user-visible
behavior of the class feature does not change.

#### 10.1 — `registerCodexAuthResolver` ✅

- [x] Chain-of-resolvers registry in `src/providers/codex.ts`:
      `registerCodexAuthResolver(fn)` `unshift`s, so newest
      registration wins. `resolveCodexAuthSource(ctx)` returns the
      first non-null result, or null if no resolver matches.
- [x] Default resolver (`instructorHostResolver`) exported and
      registered from `codex.ts` at import — fresh installs keep
      working with zero config.
- [x] Class student resolver moved to `src/class-codex-auth.ts`
      (`studentCodexAuthResolver`), exported and registered at
      import. The unshift semantics mean it auto-shadows the
      instructor without import-order coordination.
- [x] `src/index.ts` imports `./class-codex-auth.js` in a new
      class-features import block, alongside `./student-auth-handlers.js`.
- [x] 12 codex-provider tests (was 7): instructor-only chain (4),
      class+instructor chain (6), pure registry semantics
      (2 — newest-wins + all-null). 384/384 host tests green,
      tsc clean.

#### 10.2 — `registerContainerEnvContributor` ✅

- [x] New `src/container-env-registry.ts`:
      `registerContainerEnvContributor(fn)` and
      `collectContainerEnv(ctx)`. Container-runner calls collect
      once per spawn, pushes union as `-e` args.
- [x] Class contributor moved to `src/class-container-env.ts`,
      registers itself at import. `gitAuthorEnvFromMetadata` moved
      with it as a pure helper.
- [x] container-runner.ts no longer imports `getAgentGroupMetadata`
      or knows about student metadata at all — class-agnostic again.
- [x] gitAuthor tests moved from container-runner.test.ts to
      class-container-env.test.ts (still 7); +4 new registry tests
      (empty, multi-contributor concat, ctx passthrough, registration
      order). 388/388 host tests green, tsc clean.

#### 10.3 — `registerDraftMutationGate` ✅

- [x] New `src/channels/playground-gate-registry.ts`:
      `registerDraftMutationGate(gate)` and `checkDraftMutation(folder,
      action)`. First-deny-wins; empty chain allows everything.
      Action enum is `'file_put' | 'skills_put' | 'provider_put'`.
- [x] Class gate moved to `src/class-playground-gate.ts`. Wraps
      `isClassStudentDraft` + the lockdown message. The three
      inline `if (isClassStudentDraft(...)) return 403` calls in
      `playground.ts` collapse to one `checkDraftMutation` call per
      endpoint.
- [x] `playground.ts` no longer imports `isClassStudentFolder` or
      `targetFolderOf`, no longer carries `STUDENT_LOCKED_MESSAGE`
      — class-agnostic again.
- [x] 6 registry tests (default-allow, first-deny-wins, skip-allow,
      all-allow, ctx passthrough, missing-reason). 394/394 host tests
      green, tsc clean.

#### 10.4 — `registerTelegramCommand` ✅

- [x] New `src/channels/telegram-commands.ts`: `registerTelegramCommand`,
      `dispatchTelegramCommand`. Boundary-aware prefix matching
      (so `/auth` matches `/auth foo` but NOT `/authy`).
- [x] `/auth`, `/model`, `/playground` register themselves at the
      bottom of `telegram.ts`. The inline `if (text.startsWith(...))`
      block in `createAttachmentInterceptor` collapses to one
      `dispatchTelegramCommand` call gated on `text.startsWith('/')`.
- [x] `/login` handler moved to `src/class-telegram-commands.ts`,
      registers itself; imports `sendTelegramText` (now exported)
      from telegram.ts.
- [x] Telegram channel core no longer carries `/login` or its
      dependencies on `student-auth-server`'s issuance API for
      command purposes. (The pair handler still calls
      `issueAuthToken`/`buildAuthUrl` for the welcome message —
      that's Phase 10.5's territory.)
- [x] 9 dispatcher tests (no-match, match-and-consume, prefix
      boundary `/authy` rejected, exact-match, whitespace match,
      fall-through on `false`, registration-order, ctx passthrough,
      reject prefix without leading slash). 403/403 host tests
      green, tsc clean.

#### 10.5 — `registerPairConsumer` ✅

- [x] New `src/channels/pair-consumer-registry.ts`:
      `PairContext` (agentGroupId, pairedUserId, consumedEmail,
      targetFolder, channel), `PairResult` (confirmation?,
      suppressDefaultConfirmation?), `registerPairConsumer`,
      `runPairConsumers(ctx, onError?)`. Sequential execution
      (consumers may share metadata), exception-tolerant — a
      buggy consumer can't break pairing.
- [x] Class consumer moved to `src/class-pair-consumer.ts` —
      stamps metadata, creates Drive folder, issues auth token,
      composes welcome, returns `{ confirmation, suppressDefaultConfirmation: true }`.
      Non-class targets return `{}` (default confirmation fires).
- [x] Telegram pair handler retired the ~80-line inline class
      block. New shape: after wiring, call `runPairConsumers`,
      collect results, send each consumer's confirmation, fall
      back to generic confirmation only if nothing suppressed it.
- [x] `telegram.ts` no longer imports `findClassStudent`,
      `readClassConfig`, `createStudentFolder`, `getClassWelcomeText`,
      `setAgentGroupMetadataKey`, `getAgentGroupMetadata`,
      `issueAuthToken`, or `buildAuthUrl`. Class-agnostic again.
- [x] 6 registry tests (empty chain, multi-consumer collect,
      registration order, ctx passthrough, exception isolation,
      no-op shape). 409/409 host tests green, tsc clean.

#### 10.6 — Wire-up ✅

- [x] `src/index.ts` imports six class registration files in one
      block, mirroring `import './channels/index.js'` /
      `import './modules/index.js'`:
      ```
      import './class-codex-auth.js';
      import './class-container-env.js';
      import './class-pair-consumer.js';
      import './class-playground-gate.js';
      import './class-telegram-commands.js';
      import './student-auth-handlers.js';
      ```
      Phase 8 extraction is now mechanical: drop the block, copy
      those files (plus `class-config.ts`, `class-drive.ts`,
      `class-welcome.ts`, `student-auth.ts`,
      `student-auth-server.ts`, `scripts/class-skeleton.ts`,
      `data/class-config.json`, `docs/class-setup.md`) to a
      sibling branch.

**Net effect after Phase 10.** `main`'s class-specific imports
collapse to roughly:
```ts
// Class feature — registers gates, consumers, env contributors,
// auth resolvers. No-op when data/class-config.json is absent.
import './class-codex-auth.js';
import './class-container-env.js';
import './class-playground-gate.js';
import './class-pair-consumer.js';
import './class-telegram-commands.js';
import './student-auth-handlers.js';
```
All other shared files are class-free again.

### Phase 11 — Skill packaging (3 install skills + classroom branch)

**Why this exists.** Phase 10 made `main` class-agnostic by extracting
inline hooks into 5 registries. Phase 11 cashes that in: the class
feature lives on a `classroom` sibling branch, `main` carries none
of it by default, and three install skills compose what the
instructor needs:

- `/add-classroom` — base. Provisions per-student agent groups,
  pairing flow, playground lockdown, wiki-attribution env vars,
  and a short greeting in the welcome.
- `/add-classroom-gws` — adds Google Drive folder provisioning per
  student (host-side via instructor OAuth) + the rclone-mount
  bind into student containers. Layers a second pair consumer
  that sends the Drive link as its own message.
- `/add-classroom-auth` — adds per-student Codex OAuth
  (magic-link upload of a `codex login`-produced auth.json).
  Layers a third pair consumer that sends the auth link, plus
  the `/login` command and the codex resolver chain extension.

**Prerequisite (documented, not skill-installed):** `/add-agent-playground`
must be present for the playground lockdown gate to do anything
useful. The base skill checks for the playground and warns if absent.

**Key design call: multi-message welcome.** Each skill registers
its own pair consumer. After a successful pairing, the channel
delivers each consumer's confirmation as its own message — base
sends "Welcome, Alice! /playground to customize me." gws adds
"Your Drive folder: <url>." auth adds "Connect your ChatGPT:
<url>." That's 1–3 short messages depending on which skills are
installed. Each consumer is independent; no shared welcome
template, no sections registry to maintain.

#### 11.1 — Refactor pair consumer for multi-message ✅

- [x] Split `class-pair-consumer.ts` into three files:
    - `class-pair-greeting.ts` (base): metadata stamping + short
      greeting, suppresses the channel's default confirmation.
    - `class-pair-drive.ts` (gws): Drive folder creation + URL
      message. Reads `class-config.driveParent` to detect gws
      configuration; no-ops when absent. Idempotent re-pair via
      existing `meta.drive_folder_id` check.
    - `class-pair-auth.ts` (auth): magic-link issuance + URL
      message. Silent-skips when `NANOCLAW_PUBLIC_URL` is unset
      (`/login` covers retry).
- [x] Retired `class-welcome.ts` + `class-welcome.test.ts`. Each
      consumer hardcodes its own short text; no template
      composition.
- [x] Telegram pair handler unchanged — already loops over results
      and sends each `confirmation` (Phase 10.5 work).
- [x] 6th registry: `src/skeleton-mount-registry.ts` —
      `registerSkeletonMountContributor` /
      `collectSkeletonMounts`. Provision-time only; ctx includes
      student folder, name, classConfig blob (mutable), argv.
- [x] gws contributor `src/class-skeleton-drive-mount.ts` reads
      `--drive-parent` / `--drive-mount-root` from argv, mutates
      classConfig, emits Drive bind mount.
- [x] `scripts/class-skeleton-extensions.ts` — barrel script
      imports for side effects. Empty in base; gws skill appends
      `import '../src/class-skeleton-drive-mount.js';`.
- [x] `scripts/class-skeleton.ts` no longer parses Drive flags or
      knows about Drive paths. Calls `collectSkeletonMounts` per
      student. classConfig persisted after the loop so contributor
      mutations land.
- [x] +5 registry tests (default empty, concat, ctx passthrough,
      no-op contributors, classConfig mutation visible to later
      contributors). 403/403 host tests green, tsc clean.

#### 11.2 — Create the classroom sibling branch
- [ ] `git checkout -b classroom` (orphan branch isn't needed —
      we want it to share history with main so `git diff main..classroom`
      is meaningful).
- [ ] Branch contains: every class-* file currently on main,
      plus `src/student-auth*`, `scripts/class-skeleton.ts`,
      `docs/class-setup.md`, `plans/class*.md`, plus the
      googleapis dep update in `package.json`.
- [ ] Branch is pushed to origin so the skills can `git fetch
      origin classroom`.

#### 11.3 — Strip class files from main
- [ ] Remove from main: every `class-*` file, `student-auth*`,
      `class-skeleton.ts`, `googleapis` dep, the class import
      block in `src/index.ts`, the GWS section in
      `docs/class-setup.md`, `plans/class*.md`.
- [ ] **Keep on main**: the five registries from Phase 10
      (`registerCodexAuthResolver`, `registerContainerEnvContributor`,
      `registerDraftMutationGate`, `registerTelegramCommand`,
      `registerPairConsumer`). These are general extension points
      that the channels and providers also benefit from.
- [ ] After this step, main has zero class code. Tests still
      green (the registries with no consumers/resolvers are
      no-ops; existing tests verify default behavior).

#### 11.4 — `/add-classroom` skill
- [ ] `.claude/skills/add-classroom/SKILL.md`:
    - Pre-flight: check `/add-agent-playground` is installed
      (warn if not — feature still works, just no playground
      lockdown).
    - `git fetch origin classroom`.
    - Copy: `class-config.ts`, `class-config.test.ts`,
      `class-pair-greeting.ts`, `class-playground-gate.ts`,
      `class-container-env.ts`, `class-container-env.test.ts`,
      `scripts/class-skeleton.ts`, base section of
      `docs/class-setup.md`, `plans/class.md` (optional).
    - Append imports to `src/index.ts`:
      ```
      import './class-pair-greeting.js';
      import './class-playground-gate.js';
      import './class-container-env.js';
      ```
    - `pnpm exec tsc --noEmit && pnpm test`.
- [ ] `.claude/skills/add-classroom/REMOVE.md`: reverse all of
      the above. Idempotent.
- [ ] `.claude/skills/add-classroom/VERIFY.md`: smoke checks —
      does `class-config.ts` exist, do tests pass, can
      `class-skeleton.ts --count 1 --names "Test" --kb /tmp/kb
      --wiki /tmp/wiki` provision an agent group.

#### 11.5 — `/add-classroom-gws` skill
- [ ] Pre-flight: check `/add-classroom` is installed; abort
      with a clear message if not (gws builds on base).
- [ ] `git fetch origin classroom`.
- [ ] Copy: `class-drive.ts`, `class-pair-drive.ts`, gws
      section of `docs/class-setup.md`, the gws additions to
      `class-skeleton.ts` (or a patch — TBD; see open
      question below).
- [ ] Append `import './class-pair-drive.js';` to `src/index.ts`.
- [ ] `pnpm install googleapis@171.4.0`.
- [ ] `pnpm exec tsc --noEmit && pnpm test`.
- [ ] REMOVE.md: reverse, including dropping the dep with
      `pnpm remove googleapis`.
- [ ] VERIFY.md: tests pass, googleapis is in lockfile,
      `class-drive.ts` exports the expected functions.

**Decision: option (b) — sixth registry, `registerSkeletonMountContributor`.**
- Provision-time registry (mounts get baked into `container.json`
  when the skeleton runs, not at session spawn).
- Base `class-skeleton.ts` imports a barrel
  `scripts/class-skeleton-extensions.ts` (empty in base).
- The gws skill ships `src/class-skeleton-drive-mount.ts`
  (which registers a contributor that emits the Drive bind mount
  + handles `--drive-parent`/`--drive-mount-root` CLI flags) AND
  appends an import to the barrel.
- Base script writes KB + wiki mounts inline (universal; no
  extension point needed).

#### 11.6 — `/add-classroom-auth` skill
- [ ] Pre-flight: check `/add-classroom` is installed.
- [ ] `git fetch origin classroom`.
- [ ] Copy: `student-auth.ts`, `student-auth.test.ts`,
      `student-auth-server.ts`, `student-auth-server.test.ts`,
      `student-auth-handlers.ts`, `class-codex-auth.ts`,
      `class-telegram-commands.ts`, `class-pair-auth.ts`,
      `container/agent-runner/src/auth-nudge.ts`,
      `container/agent-runner/src/auth-nudge.test.ts`,
      auth section of `docs/class-setup.md`.
- [ ] Append imports to `src/index.ts`:
      ```
      import './class-codex-auth.js';
      import './class-telegram-commands.js';
      import './class-pair-auth.js';
      import './student-auth-handlers.js';
      ```
- [ ] `pnpm exec tsc --noEmit && pnpm test`.
- [ ] REMOVE.md / VERIFY.md analogous.

#### 11.7 — Smoke + finalize
- [ ] Run `/add-classroom`, then `/add-classroom-gws`, then
      `/add-classroom-auth` on a fresh main checkout. Verify
      tests stay green at each step.
- [ ] Run REMOVE in reverse order. Verify main is back to
      class-free state.
- [ ] Run on the user's actual install (the one we've been
      developing in) — this means stripping their current main
      first, then re-installing via skills. Document the
      migration steps so the user doesn't lose their
      `data/class-config.json`, `data/student-auth/`, etc.

### Phase 12 — Multi-tier roles (admin / instructor / TA / student)

**Why this exists.** Phases 1–11 modeled the class as instructor +
students only. Real classes have head instructors, co-instructors,
TAs, students. Phase 12 extends the schema + pair flow + permissions
to support all four — without inventing new role primitives
(NanoClaw already has owner/admin/scoped-admin; we use them as-is).

**Role mapping** (no new role primitives):

- **Admin** = the existing instance `owner`. Single global user.
- **Instructor** = global `admin` role. Multiple supported.
- **TA** = `admin` scoped to every `student_*` and other `ta_*`
  agent group in the class (whole-class scope). Each TA gets their
  own `ta_NN` agent group with a TA-flavored persona.
- **Student** = `agent_group_members` row on their own `student_NN`
  group (unchanged from earlier phases).

**Key design calls** (locked with the user):

- Role detection by **folder prefix**, not email. The pairing code
  carries `wire-to <folder>`; folder name decides the role.
- TA scope is **whole-class** (every TA → admin on every student).
- TA gets **their own agent** with a different default persona.
- Student `CLAUDE.md` includes `@./.class-shared.md`, a symlink to
  `data/class-shared-students.md` the instructor edits once for the
  whole class. Default content: Socratic-tutor stance + per-user
  web-hosting instruction.
- TAs and instructors do NOT include `.class-shared.md`.
- Students can read but not write the global persona — already
  enforced by the playground lockdown gate.

#### 12.1 — Playground gate signature on main ✅ (commit `0441eaf`)
- [x] `DraftMutationGate` signature changes to take a single `ctx`
      parameter `{ draftFolder, action, userId? }`.
- [x] `checkDraftMutation` accepts both legacy (folder, action)
      and ctx-shape calls.
- [x] `playground.ts`: new `cookieUserId` alongside `cookieValue`.
      `rotateCredentials()` and `startPlaygroundServer()` accept an
      optional userId; cookie session associated with whoever DMed
      `/playground`. Phase 12.5 (telegram /playground command) will
      thread the requesting user's id through.
- [x] +2 tests for the new ctx-shape semantics.

#### 12.2 — Sync gate change to classroom ✅ (cherry-pick `89ee371`)
- [x] Cherry-picked the main-side commit so classroom sees the new
      shape.

#### 12.3 — class-config schema + helpers ✅
- [x] `ClassConfig` grows `tas: ClassMember[]` and
      `instructors: ClassMember[]`. Reader defaults both to `[]`
      for back-compat.
- [x] New helpers: `findClassTa`, `findClassInstructor`,
      `isClassFolder` (broad), `classRoleForFolder` (returns the
      role string).
- [x] `isClassStudentFolder` is now an alias for `isClassFolder`.
- [x] +13 unit tests; 21 total in class-config.test.ts.

#### 12.4 — class-skeleton extensions ✅
- [x] CLI flags `--instructors "..."` and `--tas "..."`.
- [x] Three persona templates (student / TA / instructor).
- [x] Students get a 3-line @-import; TAs/instructors get a 2-line
      one (no `.class-shared.md`).
- [x] Writes `data/class-shared-students.md` once (Socratic +
      web-hosting). Symlinks each student folder's `.class-shared.md`
      to it. Copy fallback if symlinks aren't supported.
- [x] Roster CSV gains a `role` column.

#### 12.5 — Instructor + TA pair consumers ✅
- [x] `class-pair-instructor.ts`: stamps metadata, grants global
      admin, sends a short greeting.
- [x] `class-pair-ta.ts`: stamps metadata, grants scoped admin on
      every student/ta, sends a short greeting.
- [x] Existing `class-pair-greeting.ts` already only fires for
      students.

#### 12.6 — Role-aware playground gate ✅
- [x] `class-playground-gate.ts` reads `ctx.userId` and consults
      `canAccessAgentGroup`. Admin scope bypasses; member-only
      (student) keeps the lockdown.
- [x] When `userId` is null (anonymous), conservatively locks down.

#### 12.7 — Per-user web-publishing instruction ✅
- [x] `class-shared-students.md` template tells agents to use
      `/var/www/sites/<your-folder>/<sitename>/`. Persona only.

#### 12.8 — Update /add-classroom SKILL.md (pending)
- [ ] Document `--instructors` and `--tas` flags.
- [ ] Add `class-pair-instructor.ts` + `class-pair-ta.ts` to the
      copy list.
- [ ] Note the Phase 12.1 main-side dependency.

#### 12.9 — Push classroom + verify (pending)
- [ ] Push classroom to origin.
- [ ] Tests green on both branches: 345/345 main, 418/418 classroom.

## Open questions

1. **Service-account vs. per-student OAuth for Drive.** Current design uses
   a single service account that owns folders and shares with the student.
   Alternative: each student authorizes via OAuth so files belong to *them*.
   Service account is simpler to provision (no per-student auth dance) and
   matches the README. Sticking with service account.
2. **Wiki conflict resolution.** With 16 students writing concurrently to
   the same git repo, conflicts will happen. V1: last-writer-wins, agent
   handles `git pull --rebase` retries. V2 if needed: a serializing wiki
   service that linearizes writes.
3. **Per-student container limits.** 16 simultaneous containers on one
   host is fine for an instructor laptop; might not be fine on a Pi. Note
   in README, don't enforce.

## Non-goals (explicit)

- Per-student per-channel isolation beyond Telegram DM. (No Slack, no email.)
- Grade book, attendance, or LMS integration.
- Real-time class-wide broadcasts. (Instructor can do this manually by DMing
  each student or scripting it; not building first-class.)
