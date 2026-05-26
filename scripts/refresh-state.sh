#!/usr/bin/env bash
# Regenerate the auto-generated section of state.md.
# Stable sections above the AUTO-GENERATED marker are left untouched.
# Volatile section below the marker is rewritten from current git state.
#
# Called by .husky/pre-commit (auto-stages the result) and by `pnpm refresh-state`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT/state.md"
MARKER='<!-- AUTO-GENERATED — DO NOT EDIT BELOW THIS LINE -->'

if [ ! -f "$STATE_FILE" ]; then
  echo "[refresh-state] $STATE_FILE not found — skipping" >&2
  exit 0
fi

if ! grep -qF "$MARKER" "$STATE_FILE"; then
  echo "[refresh-state] AUTO-GENERATED marker not found in $STATE_FILE — refusing to overwrite" >&2
  exit 1
fi

# Preserve everything up to and including the marker + the regen-command hint line.
HEAD_END_LINE=$(grep -nF "$MARKER" "$STATE_FILE" | head -1 | cut -d: -f1)
HEAD_END_LINE=$((HEAD_END_LINE + 1))  # also keep the "Regenerate with" line right after

# Gather volatile content.
BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
STATUS=$(git -C "$ROOT" status -sb 2>/dev/null | head -20 || echo "")
RECENT_COMMITS=$(git -C "$ROOT" log --oneline -15 2>/dev/null || echo "")
LAST_TAG=$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo "(no tags)")
AHEAD_OF_TAG=$(git -C "$ROOT" rev-list --count "${LAST_TAG}..HEAD" 2>/dev/null || echo "?")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Compose new tail.
TMPFILE=$(mktemp)
head -n "$HEAD_END_LINE" "$STATE_FILE" > "$TMPFILE"
cat >> "$TMPFILE" << TAIL_EOF

## Volatile state

### Branch

- **Current:** \`$BRANCH\`
- **Last tag:** \`$LAST_TAG\` ($AHEAD_OF_TAG commits ahead)

### Working tree

\`\`\`
$STATUS
\`\`\`

### Recent commits (last 15)

\`\`\`
$RECENT_COMMITS
\`\`\`

### Last refresh

$NOW
TAIL_EOF

mv "$TMPFILE" "$STATE_FILE"
echo "[refresh-state] state.md volatile section refreshed ($NOW)"
