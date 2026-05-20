# Class setup — instructor README

Provisions a 16-student class on a single NanoClaw bot. Each student gets:
- Their own agent group (`student_<n>`) with editable persona.
- Their own DM with the bot, paired via 4-digit code.
- Their own Google Drive folder, auto-created in your Workspace.
- Read access to a shared static knowledgebase.
- Read/write access to a shared, attribution-tracked wiki.
- A scoped playground for editing their persona.

You stay global owner across all 16. Read transcripts, broadcast messages,
manage the class-wide skill set.

## What you provision

### 1. Google OAuth (instructor-owned)

The host uses your existing Google OAuth credentials to create per-student
folders in your Drive. This is user-delegated OAuth, not a service account
— files are created in your account, not a separate "bot" identity.

If you've previously authorized NanoClaw against Google
(`~/.config/gws/credentials.json` exists with `drive` in `scope`), skip
this section. Otherwise, follow the OAuth setup in `/add-gmail-tool` or
`/add-gcal-tool` skill — same OAuth client, same `gws/` directory.

Recommended: use a dedicated Google account (a 2nd account or throwaway)
so class files don't pollute your personal Drive.

### 2. Parent Drive folder

1. In your Drive, create a folder named e.g. `Class 2026 Spring` (or
   whatever you want). Note its folder ID (the part after `/folders/`
   in the URL).
2. Save the folder ID — you'll feed it to the class-skeleton script.

(No sharing step. The instructor's OAuth account already owns the folder.
Per-student subfolders inherit ownership and get shared with each
student's email automatically when they pair.)

### 3. Static knowledgebase folder

Decide where class material lives on the host:

```
sudo mkdir -p /srv/class-kb
sudo chown nano:nano /srv/class-kb
```

Drop course PDFs, syllabi, notes into `/srv/class-kb/`. The agent-runner
in each student's container will mount this read-only at `/workspace/kb/`.

### 4. rclone mount of the parent folder

Each student's container needs a real-filesystem view of *only* their own
Drive subfolder at `/workspace/drive/`. We get this by running ONE rclone
process for the whole class, anchored at the parent folder ID, and
bind-mounting per-student subdirs into containers.

Why this shape (vs. an in-container Drive MCP or per-student rclone): one
process for 16 students; the agent (Codex, Claude, anything) uses a normal
filesystem so `cat`/`ls`/Read/Write all Just Work; the instructor's
full-Drive OAuth refresh token never enters any container.

```bash
# 1. Install rclone
sudo apt install rclone   # or `brew install rclone` on macOS

# 2. Configure a Drive remote anchored at the parent folder.
rclone config
#   n  (new remote)
#   name> class-drive
#   storage> drive
#   client_id / client_secret> (paste the same values from ~/.config/gws/credentials.json,
#                               or leave blank to use rclone's defaults)
#   scope> 1   (full access — needed because per-student folders inherit
#               from the parent and rclone needs write to upload)
#   service_account_file> (blank)
#   Edit advanced config> n
#   Use auto config> y   (browser opens; authorize the same Google account
#                         that owns ~/.config/gws/credentials.json)
#   Configure as Shared Drive> n
#   root_folder_id> <PARENT_FOLDER_ID>   (the same one passed to --drive-parent)
#   y/y  (keep config, quit)

# 3. Create the mount point + add to NanoClaw's mount allowlist.
mkdir -p ~/nanoclaw-drive-mount
# (~/.config/nanoclaw/mount-allowlist.json: add the path so the host will
# bind-mount its subdirs into student containers.)

# 4. Run rclone mount in the background. systemd user unit recommended for
#    auto-restart; one-shot form for testing:
rclone mount class-drive: ~/nanoclaw-drive-mount/ \
  --vfs-cache-mode writes \
  --dir-cache-time 30s \
  --poll-interval 15s \
  --daemon
```

`--dir-cache-time 30s` + `--poll-interval 15s` keep the listing fresh so
newly-created student folders show up within ~15s of pairing without
hammering the API.

### 5. Shared wiki (git-backed for attribution)

```
mkdir -p /srv/class-wiki
cd /srv/class-wiki && git init
git config --local user.email class-bot@local
echo "# Class Wiki" > index.md
git add index.md && git commit -m "init"
```

Each student's container will mount this read/write at `/workspace/wiki/`.
Per-student git identity is set inside the container at spawn time so
commits to the wiki carry attribution (`student_07 <student_07@class.local>`).

## What the script does

Run:

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 16 \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy,Kenneth,Leo,Mia,Noor,Oscar,Pat" \
  --drive-parent <FOLDER_ID> \
  --drive-mount-root ~/nanoclaw-drive-mount \
  --kb /srv/class-kb \
  --wiki /srv/class-wiki
```

`--drive-mount-root` defaults to `~/nanoclaw-drive-mount`; pass it
explicitly only if your rclone mount target differs.

This creates:

- 16 `groups/student_<n>/` directories with starter CLAUDE.md +
  CLAUDE.local.md + container.json (KB ro, wiki rw, drive rw mounts).
- 16 `agent_groups` rows (`student_01` … `student_16`).
- 16 four-digit pairing codes via the existing `wire-to` pairing flow.
- A CSV at `class-roster.csv` mapping name ↔ student folder ↔ pairing code.

The drive mount in each `container.json` points at
`<drive-mount-root>/<folder> — <name>` (em dash, matching the folder
name `class-drive.ts` creates). Until the student pairs, that subdir
doesn't exist yet — rclone will surface it after pair-time folder
creation, typically within ~15s.

The Drive folders are created lazily on first pairing — when a student
sends their pairing code along with their email, the bot creates
`<parent>/student_<n>/`, shares with the student's email, and records
the folder ID on their agent group.

## Distributing pairing codes

Hand each student their code (out-of-band — email, classroom, whatever).
Their first message to the bot must be:

```
<code> <their-google-workspace-email>
```

(e.g., `1234 alice@school.edu`)

The bot:
1. Validates the code.
2. Pairs their Telegram chat → `student_<n>` agent group.
3. Creates their Drive folder, shares with their email.
4. Sends a welcome message.

## Verifying

After all 16 are paired:

```bash
sqlite3 data/v2.db "SELECT u.id, ag.folder FROM users u
                    JOIN messaging_groups mg ON mg.platform_id = REPLACE(u.id, ':', ':')
                    JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
                    JOIN agent_groups ag ON ag.id = mga.agent_group_id
                    WHERE ag.folder LIKE 'student_%'"
```

Should show 16 rows.

## Privacy notice for students

The bot sends a welcome + privacy notice automatically after each
student's first successful pairing. The default text covers:

- A greeting using the student's name from `class-config.json`.
- A clickable link to their Drive folder.
- A pointer to `/playground` for persona customization.
- The privacy notice ("your conversations, persona edits, and wiki
  contributions are visible to your instructor; KB and wiki are shared
  with all classmates").

To customize, drop a `data/class-welcome.md` file with your own text.
Variables `{name}` and `{drive_url}` get substituted at send time. No
restart needed — the file is read on each pair.
