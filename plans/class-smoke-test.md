# Class feature — end-to-end smoke test

Runbook for Phase 7. Provisions a 2-student test class, paires both
students from real Telegram accounts, and walks through every assertion
the class feature makes about itself.

> Run this against a **throwaway** Google account or a dedicated test
> Workspace — not the instructor's main account. The test creates real
> Drive folders, real shares, and real wiki commits.

## Pre-flight (instructor side, one-time)

Before running the skeleton, the host needs:

- [ ] `~/.config/gws/credentials.json` — OAuth credentials with Drive
      scope. `cat ~/.config/gws/credentials.json | jq '.scope'` should
      contain `https://www.googleapis.com/auth/drive`. If not, run
      `/add-gmail-tool` or `/add-gcal-tool` first.
- [ ] `rclone` installed (`rclone --version` works).
- [ ] An rclone remote named `class-drive` configured against the
      instructor's account. Verify with `rclone listremotes` →
      `class-drive:` should appear.
- [ ] A parent Drive folder created in the instructor's account (e.g.
      "Class smoke test"). Note its folder ID — that's the value for
      `--drive-parent`.
- [ ] The remote's `root_folder_id` set to that parent (during
      `rclone config`'s "edit existing remote" flow). `rclone lsd
      class-drive:` should list folders *inside* the parent, not the
      whole Drive.
- [ ] Mount target exists and is in the allowlist:
      ```
      mkdir -p ~/nanoclaw-drive-mount
      jq '.allowlist += ["/home/nano/nanoclaw-drive-mount"]' \
        ~/.config/nanoclaw/mount-allowlist.json > /tmp/al.json && \
        mv /tmp/al.json ~/.config/nanoclaw/mount-allowlist.json
      ```
- [ ] KB and wiki paths exist and are in the allowlist (e.g. `/tmp/kb`
      and `/tmp/wiki`). Init the wiki: `cd /tmp/wiki && git init &&
      echo '# Class wiki' > index.md && git add . && git commit -m init`.
- [ ] rclone mount running:
      ```
      rclone mount class-drive: ~/nanoclaw-drive-mount/ \
        --vfs-cache-mode writes --dir-cache-time 30s \
        --poll-interval 15s --daemon
      ```
      Verify with `mount | grep nanoclaw-drive-mount`.
- [ ] NanoClaw service running (`systemctl --user status nanoclaw` or
      the macOS launchd equivalent).

## 1. Provision the test class (2 students)

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 2 \
  --names "Alice,Bob" \
  --drive-parent <FOLDER_ID> \
  --kb /tmp/kb \
  --wiki /tmp/wiki
```

**Verify:**

- [ ] `data/class-config.json` exists. `jq '.students | length'` returns
      `2`. `jq '.driveParent'` returns the folder ID.
      `jq '.driveMountRoot'` returns
      `"/home/nano/nanoclaw-drive-mount"`.
- [ ] `class-roster.csv` exists with two rows (Alice, Bob).
- [ ] `groups/student_01/` and `groups/student_02/` exist; each has
      `CLAUDE.md`, `CLAUDE.local.md`, `container.json`.
- [ ] `container.json` for each contains an `additionalMounts` entry
      pointing at `~/nanoclaw-drive-mount/student_01 — Alice`
      (em-dash, with the student's name) → `/workspace/drive`.
- [ ] DB:
      ```
      sqlite3 data/v2.db \
        "SELECT folder FROM agent_groups WHERE folder LIKE 'student_%' ORDER BY folder"
      ```
      Returns `student_01`, `student_02`.

## 2. Pair Student 1 (Alice)

From Alice's real Telegram account, DM the bot:

```
<code-from-roster> alice@school.edu
```

**Verify within 30 seconds:**

- [ ] Telegram chat shows the **class welcome** message (not the
      generic "Pairing success!"). It contains: greeting using
      "Alice", a Drive folder URL, the privacy notice, and a
      `/playground` pointer.
- [ ] In the instructor's Drive UI, a folder named
      `student_01 — Alice` exists under the parent. It's shared with
      `alice@school.edu` as Editor.
- [ ] After ~15s for rclone's poll cycle:
      `ls "/home/nano/nanoclaw-drive-mount/student_01 — Alice"`
      succeeds (empty initially).
- [ ] DB metadata:
      ```
      sqlite3 data/v2.db \
        "SELECT json_extract(metadata, '$.student_name'),
                json_extract(metadata, '$.student_email'),
                json_extract(metadata, '$.drive_folder_id'),
                json_extract(metadata, '$.drive_folder_url')
         FROM agent_groups WHERE folder = 'student_01'"
      ```
      Returns Alice's name, email, a non-empty folder ID, and a
      `https://drive.google.com/...` URL.
- [ ] DB wiring: `messaging_group_agents` row exists linking Alice's
      Telegram chat to `student_01`'s agent group. The row has
      `engage_mode = 'pattern'` and `engage_pattern = '.'` (DM auto-respond).

## 3. Pair Student 2 (Bob)

Same as step 2 from Bob's account with `bob@school.edu`. Same checks
against `student_02`.

## 4. First conversation + Drive mount sanity

Alice DMs the bot: `say hi and run "ls /workspace/drive" then "touch /workspace/drive/test.txt && ls -la /workspace/drive"`

**Verify:**

- [ ] Bot responds. The `ls` output shows `/workspace/drive` is
      empty initially, then contains `test.txt` after the second
      command.
- [ ] After ~15s, in instructor's Drive UI: `test.txt` appears in
      `student_01 — Alice`.
- [ ] In Alice's Drive UI (same email): the file is visible (the
      folder was shared with her).

## 5. Wiki attribution (Phase 4)

Alice DMs: `commit a wiki file: write to /workspace/wiki/alice.md the
text "Alice was here", then cd /workspace/wiki && git add alice.md &&
git commit -m "Alice's first note"`

**Verify on host:**

```
cd /tmp/wiki && git log --pretty=fuller -1
```

- [ ] `Author:` line shows `Alice Chen <alice@school.edu>` (not
      `student_01@class.local`, not the instructor, not blank).
- [ ] `Commit:` (committer) line shows the same.

Repeat from Bob's chat with a `bob.md` file. Check that
`git log --pretty=fuller` shows distinct authors per commit.

## 6. Playground lockdown (Phase 5)

Alice DMs the bot: `/playground`. The bot replies with a magic-link URL.

In a browser, open the URL. The playground should auto-auth Alice into
**her** draft only (not the global owner view). Verify:

- [ ] Sidebar lists exactly one draft, targeting `student_01`.
- [ ] **Edit Persona** pane: load works, save (`PUT /api/drafts/.../persona`)
      returns 200. The draft's `CLAUDE.local.md` updates on disk.
- [ ] **Files editor** pane (advanced UI): try to PUT a change to any
      file via `curl` against the API directly with the playground
      cookie. Expected: **403** with body
      `{"error": "Class-student drafts only allow persona edits..."}`.
      ```
      curl -b "nc_playground=$COOKIE" -X PUT \
        -H 'content-type: application/json' \
        -d '{"text":"x"}' \
        http://localhost:<port>/api/drafts/draft_student_01/files/container.json
      ```
- [ ] Same 403 on PUT `/api/drafts/draft_student_01/skills`.
- [ ] Same 403 on PUT `/api/drafts/draft_student_01/provider`.
- [ ] GET endpoints all return 200 (reading shared CLAUDE.md is fine).

## 7. Instructor visibility

From the instructor's chat (owner), verify the existing transcript
mechanism shows both students' conversations. (Specifics depend on
which transcript surface the instructor uses — `/transcripts`,
direct `data/v2-sessions/<ag-id>/.../outbound.db` reads, etc.)

- [ ] Verifier SQL from `docs/class-setup.md` returns 2 rows:
      ```
      sqlite3 data/v2.db "SELECT u.id, ag.folder FROM users u
        JOIN messaging_groups mg ON mg.platform_id = REPLACE(u.id, ':', ':')
        JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE ag.folder LIKE 'student_%'"
      ```

## 8. Idempotency

- [ ] Re-run `class-skeleton.ts --count 2 --names "Alice,Bob" ...`. All
      `[skip]` lines for existing agent groups; no duplicate
      `agent_groups` rows. CSV regenerated. `class-config.json`
      regenerated (same content).
- [ ] Have Alice re-pair (DM bot a fresh code; codes are issued by
      re-running skeleton or via owner command). Verify the existing
      Drive folder is **reused** (same `drive_folder_id` on metadata,
      no second folder in instructor's Drive, no duplicate share for
      `alice@school.edu`).

## 9. Failure-mode spot-checks

- [ ] **Drive call temporarily failing**: rename
      `~/.config/gws/credentials.json` to `.json.bak`, restart
      NanoClaw, repeat pairing for a third throwaway student. Expected:
      pairing still succeeds, welcome message shows the "(Drive folder
      pending — check back in a minute)" placeholder, error is logged
      in `logs/nanoclaw.error.log` with the underlying message.
      Restore the credentials file before continuing.
- [ ] **rclone mount stale**: `kill` the rclone process. Alice tries
      to write to `/workspace/drive`. Expected: container's bind mount
      shows the underlying empty/missing dir; agent's `touch` fails;
      conversation shows the failure. Re-start rclone; next message
      works again.

## 10. Cleanup

After the smoke test:

- [ ] Manually delete the test parent Drive folder (cascades to
      student subfolders).
- [ ] `git -C /tmp/wiki log` — keep or wipe per preference.
- [ ] DB cleanup if you want a clean slate:
      ```
      sqlite3 data/v2.db <<SQL
        DELETE FROM messaging_group_agents WHERE agent_group_id IN
          (SELECT id FROM agent_groups WHERE folder LIKE 'student_%');
        DELETE FROM agent_groups WHERE folder LIKE 'student_%';
        DELETE FROM messaging_groups WHERE platform_id LIKE 'telegram:%'
          AND id NOT IN (SELECT messaging_group_id FROM messaging_group_agents);
      SQL
      ```
      (Or just `rm -rf data/` for a full reset.)
- [ ] `rm -rf groups/student_*` (groups don't auto-delete with rows).
- [ ] `rm data/class-config.json class-roster.csv` if you want the
      pair handler to stop treating any `student_*` folder as a
      class flow.

## What gets exposed if this all passes

- A class instructor can stand up 16 student bots with one script run
  + ~5 minutes of OAuth/rclone/wiki setup.
- Each student's Drive folder is auto-provisioned and shared on first
  pair, with a tailored welcome they actually read.
- Wiki commits are attributed to real students by name + school email.
- Students can customize their agent's persona via `/playground` but
  cannot change provider, skills, mounts, or the shared CLAUDE.md.
- The instructor stays global owner; their full-Drive OAuth never
  leaves the host.

## What this runbook does NOT cover

- Phase 3c.3 (Doc-only MCP). Not built; deferred until a smoke-test
  participant actually needs to read/write Google Docs as text.
- Phase 8 (`/setup-class` skill packaging). Deferred.
- 16-student concurrent load. Test with 2; if everything's clean,
  scale up. The DB design has no contention concern at 16, but
  rclone fuse + 16 simultaneous `cd /workspace/drive` users hasn't
  been measured.
