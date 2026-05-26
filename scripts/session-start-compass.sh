#!/usr/bin/env bash
# SessionStart hook: print the stable head of state.md so every new Claude
# session lands with project orientation already in context. Stops at the
# AUTO-GENERATED marker — the volatile section is too noisy for a banner
# (the session can read state.md in full if it needs more).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$ROOT/state.md"

if [ ! -f "$STATE_FILE" ]; then
  echo "⚠️  state.md not found at repo root — orient via CLAUDE.md and README.md instead."
  exit 0
fi

MARKER='<!-- AUTO-GENERATED — DO NOT EDIT BELOW THIS LINE -->'
LINE_BEFORE_MARKER=$(grep -nF "$MARKER" "$STATE_FILE" | head -1 | cut -d: -f1 || true)

if [ -z "$LINE_BEFORE_MARKER" ]; then
  # No marker — print whole file
  echo "═══ state.md (project compass — read before starting work) ═══"
  cat "$STATE_FILE"
  exit 0
fi

# Print everything up to (not including) the marker, then a one-line
# pointer for the volatile section.
echo "═══ state.md (project compass — read fully before any new implementation) ═══"
head -n $((LINE_BEFORE_MARKER - 1)) "$STATE_FILE"
echo ""
echo "(Volatile branch/commits state available below the marker in state.md — run \`pnpm refresh-state\` if stale.)"
