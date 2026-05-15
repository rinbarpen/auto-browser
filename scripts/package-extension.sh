#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/extension"
DIST_DIR="$ROOT/dist"

# Read version from manifest
VERSION="$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])" 2>/dev/null)" || {
  echo "Error: Cannot read version from extension/manifest.json"
  exit 1
}

OUTPUT="$DIST_DIR/auto-browser-extension-v$VERSION.zip"

mkdir -p "$DIST_DIR"

# Create zip with only the files Chrome needs
cd "$EXT_DIR"
zip -q -X "$OUTPUT" \
  manifest.json \
  background.js \
  background-state.js \
  content-script.js \
  content-helpers.js \
  start-task.js \
  sidepanel.html \
  sidepanel.css \
  sidepanel.js \
  sidepanel-state.js

cd "$ROOT"

FILE_COUNT=$(unzip -l "$OUTPUT" 2>/dev/null | tail -1 | awk '{print $2}')
FILE_SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT" 2>/dev/null)
echo "Created $OUTPUT ($((FILE_SIZE / 1024))KB, $FILE_COUNT files)"
