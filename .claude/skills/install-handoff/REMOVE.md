# Remove `/install-handoff`

Reverts the install-handoff skill. After REMOVE, `ncl handoffs` is gone, the handoff HTTP server no longer starts, and sweep no longer purges handoff tokens.

## 1. Stop the host

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user stop nanoclaw
```

## 2. Remove the lifecycle hook from `src/index.ts`

Delete the sentinel-bounded block (including the sentinel comment lines themselves):

```typescript
  // install-handoff:lifecycle START
  const { startHandoffServer, stopHandoffServer } = await import('./install-handoff/server.js');
  await startHandoffServer();
  onShutdown(async () => { await stopHandoffServer(); });
  // install-handoff:lifecycle END
```

Or use a node one-liner (safe to re-run — exits 0 if the sentinel is absent):

```bash
node -e "
const fs = require('fs');
const f = 'src/index.ts';
const src = fs.readFileSync(f, 'utf8');
const out = src.replace(
  /\n  \/\/ install-handoff:lifecycle START\n[\s\S]*?\/\/ install-handoff:lifecycle END\n/,
  '\n'
);
if (out !== src) { fs.writeFileSync(f, out); console.log('Removed lifecycle block from', f); }
else { console.log('Sentinel not found in', f, '— already removed.'); }
"
```

## 3. Remove the sweep hook from `src/host-sweep.ts`

Delete the sentinel-bounded block:

```typescript
    // install-handoff:sweep START
    try {
      const { sweepExpiredHandoffs } = await import('./install-handoff/store.js');
      sweepExpiredHandoffs();
    } catch (err) {
      log.warn('install-handoff sweep failed', { err });
    }
    // install-handoff:sweep END
```

Or use a node one-liner:

```bash
node -e "
const fs = require('fs');
const f = 'src/host-sweep.ts';
const src = fs.readFileSync(f, 'utf8');
const out = src.replace(
  /\n    \/\/ install-handoff:sweep START\n[\s\S]*?\/\/ install-handoff:sweep END\n/,
  '\n'
);
if (out !== src) { fs.writeFileSync(f, out); console.log('Removed sweep block from', f); }
else { console.log('Sentinel not found in', f, '— already removed.'); }
"
```

## 4. Remove the migration registration from `src/db/migrations/index.ts`

There are two sentinel pairs to remove — one in the import block, one in the migrations array.

```bash
node -e "
const fs = require('fs');
const f = 'src/db/migrations/index.ts';
const original = fs.readFileSync(f, 'utf8');
let src = original;
// Remove import block sentinel
src = src.replace(
  /\n\/\/ install-handoff:migrations START\nimport \{ moduleInstallHandoffs \}.*?\n\/\/ install-handoff:migrations END\n/s,
  '\n'
);
// Remove array entry sentinel
src = src.replace(
  /\n\/\/ install-handoff:migrations START\n  moduleInstallHandoffs,\n\/\/ install-handoff:migrations END\n/,
  '\n'
);
if (src !== original) { fs.writeFileSync(f, src); console.log('Removed migration sentinels from', f); }
else { console.log('No migration sentinels found in', f, '(already removed)'); }
"
```

## 5. Remove the CLI resource registration from `src/cli/resources/index.ts`

```bash
node -e "
const fs = require('fs');
const f = 'src/cli/resources/index.ts';
const src = fs.readFileSync(f, 'utf8');
const out = src.replace(/\nimport '.\/handoffs\.js';\n/, '\n');
if (out !== src) { fs.writeFileSync(f, out); console.log('Removed handoffs import from', f); }
else { console.log('Import not found in', f, '— already removed.'); }
"
```

## 6. Delete source files

```bash
rm -rf src/install-handoff
rm -f  src/cli/resources/handoffs.ts
rm -f  src/db/migrations/module-install-handoffs.ts
```

## 7. Delete runtime data

```bash
rm -rf data/handoffs/
```

Bundle files and their token directories are deleted here. The `handoffs` table in `data/v2.db` is left in place intentionally — the migration's `CREATE TABLE IF NOT EXISTS` is idempotent, so re-installing later is safe. The table is empty once all tokens have been swept or revoked; leaving it costs nothing.

**Optional — wipe the table and schema_version row:**

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DROP TABLE IF EXISTS handoffs"
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM schema_version WHERE name = 'install-handoffs'"
```

Only needed if you want a clean slate for a future re-install that would otherwise see the migration as already applied.

## 8. Remove env vars

In `.env`, remove or comment out:

```
INSTALL_HANDOFF_PORT
INSTALL_HANDOFF_PUBLIC_URL
```

## 9. Build and restart

```bash
pnpm run build

# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user start nanoclaw
```
