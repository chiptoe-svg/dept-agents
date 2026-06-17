# Setup service sudo prompt

## Problem

The macOS service setup step installs a LaunchDaemon plist under
`/Library/LaunchDaemons`, which requires `sudo`.

`setup:auto` runs setup steps in a quiet child process with stdin closed.
When the service step reaches:

```
sudo install -m 644 -o root -g wheel ...
```

`sudo` can wait for a password that the user never sees, making setup appear
to spin forever.

## Plan

1. Prompt for `sudo` in the interactive setup parent before launching the
   quiet `service` step.
2. Change macOS service-step `sudo` calls to use non-interactive `sudo -n`
   so a missing sudo cache fails fast instead of hanging.
3. Emit an explicit setup status error for missing sudo credentials.
4. Validate the setup help path and the focused service behavior where
   possible without installing a LaunchDaemon during tests.
