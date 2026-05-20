#!/bin/bash
# One-time helper: wrap each saved brainstorm fragment in the frame template
# so the files render standalone via the static file server.
# Run this once after copying fragments out of .superpowers/brainstorm/.
set -e
cd "$(dirname "$0")"
FRAME="/home/nano/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/scripts/frame-template.html"
for f in [0-9]*.html; do
  # Skip if already a full document.
  if head -1 "$f" | grep -qi '<!doctype\|<html'; then continue; fi
  body=$(cat "$f")
  awk -v body="$body" '
    /<!-- CONTENT -->/ { print body; next }
    { print }
  ' "$FRAME" > "$f.tmp" && mv "$f.tmp" "$f"
done
echo "Wrapped: $(ls [0-9]*.html | wc -l) files"
