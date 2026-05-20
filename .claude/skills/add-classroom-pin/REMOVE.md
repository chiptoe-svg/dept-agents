# Remove `/add-classroom-pin`

Reverts the email-PIN 2FA layer. After REMOVE, class-token URLs go back to "click → in" behavior.

## 1. Disable PIN gate in your classroom bootstrap

Find and comment out (or delete) the line in your classroom module:

```typescript
setPinRequiredForClassToken(true);
```

(That alone is enough to deactivate PIN — students stop being redirected to `/login/pin`. The rest of this REMOVE just cleans up files.)

## 2. Remove source files

```bash
rm -f src/class-login-pins.ts \
      src/class-login-pins.test.ts \
      src/db/migrations/module-class-login-pins.ts \
      src/channels/playground/api/login-pin.ts \
      src/channels/playground/api/login-pin.test.ts \
      src/channels/playground/public/login-pin.html
```

## 3. Unregister migration

In `src/db/migrations/index.ts`, remove:

```typescript
import { moduleClassLoginPins } from './module-class-login-pins.js';
```

…and remove `moduleClassLoginPins` from the `migrations` array.

## 4. Optional: drop the database table

Per-install state. Only run if you want to wipe pending PINs (rarely needed since they auto-expire):

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DROP TABLE class_login_pins"
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM schema_version WHERE name = 'class-login-pins'"
```

## 5. Build + restart

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

Trunk patches at the `classroom-pin:hook START / END` and `classroom-pin:routes START / END` sentinels in `auth-store.ts` and `server.ts` are leave-as-is — they're inert when no skill calls `setPinRequiredForClassToken(true)` and the routes 404 when nothing reaches them. If you want them gone too, delete the bracketed regions; both files build cleanly without them.
