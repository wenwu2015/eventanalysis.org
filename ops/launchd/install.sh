#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NPM="$(command -v npm)"
NODE_BIN="$(dirname "$(command -v node)")"
TARGET="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

cd "$ROOT"
npm run automation:ready
mkdir -p "$TARGET" "$ROOT/pipeline/runtime/launchd"
for template in "$ROOT"/ops/launchd/*.plist.template; do
  name="$(basename "$template" .template)"
  output="$TARGET/$name"
  sed -e "s|__ROOT__|$ROOT|g" -e "s|__NPM__|$NPM|g" -e "s|__PATH__|$NODE_BIN:/usr/local/bin:/usr/bin:/bin|g" "$template" > "$output"
  plutil -lint "$output" >/dev/null
  launchctl bootout "$DOMAIN" "$output" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$output"
done
echo "EventAnalysis launchd jobs installed."
