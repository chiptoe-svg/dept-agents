# `/install-handoff` skill — magic-link install bundles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/install-handoff` skill that generates a time-limited, single-use URL bundling everything needed to clone this NanoClaw install onto a new machine (Mac, Linux, future Windows). Replaces the hand-rolled `_migrate-OFY3SqmfKqNYWFfoYIEUJQ/` + `python -m http.server` pattern with first-class tooling.

**Architecture:** Small dedicated HTTP server on port 3008 (configurable), launched as part of the host service when the skill is installed. Token state lives in a SQLite migration on the central DB (`install_handoffs` table). Bundles are staged under `data/handoffs/<token>/`. On token issue: gather files, write metadata row, return URLs. On HTTP request: middleware checks token validity + decrements use counter; serves the requested file; if exhausted (uses=0 or expired), deletes filesystem dir and row. Sweep loop in `host-sweep.ts` catches anything missed.

**Tech Stack:** Node http (no Express), better-sqlite3 for token store, tar-stream for `groups/` bundling, pure JS in install template (platform detect).

---

## Bundle contents (per scope decision)

**Default bundle** (small, ~3KB total):
- `.env` — top-of-repo
- `gws/credentials.json`, `gws/client_secret.json` — from `~/.config/gws/`
- `codex/auth.json`, `codex/config.toml` — from `~/.codex/`

**Opt-in via `--include`**:
- `groups` — `groups/` dir tarballed (skip `groups/*/data/` if any session state lives there). Could be MB-sized depending on per-agent customizations.
- `claude-creds` — `~/.claude/.credentials.json` (Linux-to-Linux clones; no-op on macOS where it's in Keychain).

`--exclude` flag drops items from the default bundle (e.g. `--exclude codex` if no Codex agent on the destination).

## Token + lifecycle semantics

- **TTL**: default 24h, max 7d. `--ttl 30m` / `--ttl 12h` / `--ttl 7d` syntax.
- **Max uses**: default 1 (single-use), max 10. `--max-uses 3`.
- **Whole-bundle counter**: ONE counter per handoff, decremented on every successful file download. When counter hits 0 OR `expires_at` passes, handoff is exhausted. (Simpler than per-file counters; "1 use = 1 full clone attempt".)
- **install.html NOT counted**: refreshable as long as not exhausted.
- **Exhaustion**: sweep deletes the filesystem dir and DB row.
- **Manual revoke**: `ncl handoffs revoke <id>` immediately exhausts.

## Platform-aware install template

`install.html` ships with both Mac (launchctl/brew) and Linux (systemd/apt) blocks. JS at page load detects via `navigator.platform` + `navigator.userAgent` and shows the matching block, with a "Show other platform" toggle. The `bash nanoclaw.sh` step is identical across platforms; only service-management commands differ.

## File structure

- `.claude/skills/install-handoff/SKILL.md` — operator-facing install/usage skill
- `.claude/skills/install-handoff/REMOVE.md` — uninstall script (delete files, drop DB table, restart)
- `.claude/skills/install-handoff/add/` — overlay copied into trunk paths on install:
  - `add/src/install-handoff/server.ts` (~150 LoC) — HTTP server, route handlers, use-decrement
  - `add/src/install-handoff/store.ts` (~100 LoC) — `issueHandoff()`, `consumeFile()`, `revokeHandoff()`, `sweepExpiredHandoffs()`
  - `add/src/install-handoff/bundler.ts` (~120 LoC) — gather files, tar groups, write to `data/handoffs/<token>/`
  - `add/src/install-handoff/install-template.html` — platform-aware install guide
  - `add/src/db/migrations/module-install-handoffs.ts` — `install_handoffs` table
  - `add/src/cli/resources/handoffs.ts` — `ncl handoffs create|list|revoke`
  - Tests: `*.test.ts` for store, bundler, server

## Phases

### Phase 1 — Skill scaffolding

- [ ] **Step 1: Create skill directory + SKILL.md**

```bash
mkdir -p .claude/skills/install-handoff/add/src/{install-handoff,db/migrations,cli/resources}
```

- [ ] **Step 2: Write SKILL.md (idempotent install steps, prereqs, configure section, usage examples)**
- [ ] **Step 3: Write REMOVE.md (inverse — delete files, drop DB rows, no schema rollback for safety)**
- [ ] **Step 4: Commit scaffold**

### Phase 2 — DB migration + token store

- [ ] **Step 1: Write `module-install-handoffs.ts`** — schema:
  ```sql
  CREATE TABLE install_handoffs (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER NOT NULL,
    current_uses INTEGER NOT NULL DEFAULT 0,
    files_json TEXT NOT NULL,   -- [{name, size}] for serving validation
    revoked_at TEXT
  );
  CREATE INDEX install_handoffs_token_idx ON install_handoffs(token);
  ```
- [ ] **Step 2: Write store.ts** — `issueHandoff(opts)`, `getHandoff(token)`, `consumeHandoff(token)` (decrements whole-bundle counter), `revokeHandoff(id)`, `sweepExpiredHandoffs()`
- [ ] **Step 3: Tests** — issue → validate → consume each file once → exhaust → sweep cleans
- [ ] **Step 4: Run typecheck + test**
- [ ] **Step 5: Commit**

### Phase 3 — Bundler

- [ ] **Step 1: Write bundler.ts** — `bundleHandoff(token, manifest)` writes files into `data/handoffs/<token>/`, returns the file list with sizes
- [ ] **Step 2: Tar logic for groups/** (use Node's built-in for simplicity, fall back to `tar` CLI if needed)
- [ ] **Step 3: Tests** — bundling deterministic, missing files raise clear errors, partial-bundle on missing-but-optional sources
- [ ] **Step 4: Commit**

### Phase 4 — HTTP server

- [ ] **Step 1: Write server.ts** — start on `INSTALL_HANDOFF_PORT` (default 3008); routes:
  - `GET /handoff/:token/install.html` — render template with token + URLs filled in (NOT counted)
  - `GET /handoff/:token/:file` — validate token + file membership; serve + call `consumeHandoff(token)`; on counter=0, mark revoked
- [ ] **Step 2: Wire start/stop into `src/index.ts`** lifecycle
- [ ] **Step 3: Tests** — token validation, file serving, decrement, exhaustion, expiry response
- [ ] **Step 4: Commit**

### Phase 5 — Install template (platform-aware)

- [ ] **Step 1: Write `install-template.html`** — both Mac + Linux blocks with `data-platform` attrs, JS detect on load
- [ ] **Step 2: Server fills `{{TOKEN}}`, `{{HOST_URL}}`, `{{FILES}}` placeholders at request time**
- [ ] **Step 3: Visual smoke** — load on macOS Safari, see Mac block; load on Linux Firefox, see Linux block
- [ ] **Step 4: Commit**

### Phase 6 — CLI

- [ ] **Step 1: Write `cli/resources/handoffs.ts`** — `create`, `list`, `revoke` verbs
- [ ] **Step 2: Wire into `cli/resources/index.ts` registry**
- [ ] **Step 3: `create` output format** — print URL prominently, show expiry + max-uses, copy-friendly
- [ ] **Step 4: Tests** — verb dispatch, args validation, output format
- [ ] **Step 5: Commit**

### Phase 7 — Sweep + lifecycle hooks

- [ ] **Step 1: Add `sweepExpiredHandoffs()` call to `host-sweep.ts`** — runs every 60s
- [ ] **Step 2: On host startup** — sweep once before serving, in case anything was orphaned across restarts
- [ ] **Step 3: Tests** — sweep deletes filesystem dir AND DB row for expired
- [ ] **Step 4: Commit**

### Phase 8 — Live smoke

- [ ] **Step 1: Install the skill** (run `/install-handoff` from Claude Code on this Linux box)
- [ ] **Step 2: Run `ncl handoffs create --ttl 1h`** — get URL
- [ ] **Step 3: Open URL on Mac browser** — install.html renders, Mac block visible
- [ ] **Step 4: Run the curl block** — files download, counter decrements
- [ ] **Step 5: Re-run curl block** — second attempt 404s (single-use)
- [ ] **Step 6: `ncl handoffs list`** — handoff shows as exhausted; sweep cleans within 60s
- [ ] **Step 7: Document outcomes in this plan**

### Phase 9 — Retire `_migrate-*` + python http.server pattern

- [ ] **Step 1: Strip live URLs from `docs/install-mac-studio.html`** — replace with `<your-handoff-url>` placeholder + pointer to the new skill
- [ ] **Step 2: Kill the python http.server** (`kill 303769`)
- [ ] **Step 3: Update docs/install-mac-studio.html banner: "use /install-handoff to regenerate this guide for your install"**

## Non-goals (deliberately out)

- **HTTPS/TLS** — leave as plain HTTP; add behind a reverse proxy if needed. Magic-link security is the unguessable token, same as today.
- **Auth on the handoff URL** — the token IS the auth. No additional bearer/cookie needed.
- **Cross-machine groups/ live sync** — this is a one-shot copy. If you want continuous sync, that's a different feature.
- **Bundling session DBs** (`data/v2-sessions/`) — runtime state, not portable. Out of scope.
- **Migration of `data/v2.db`** — covered by the "Full mirror" option from the earlier scope question; separately gated behind `--include central-db` flag if ever needed (not in MVP).

## Estimated effort

~6-8 hours of focused work. Self-contained, no upstream coordination. Most complexity is in the test matrix; the runtime code is small.
