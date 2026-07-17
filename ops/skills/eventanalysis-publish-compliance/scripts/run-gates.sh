#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CONTENT_ID="${1:-}"

if [[ -z "$CONTENT_ID" ]]; then
  echo "usage: run-gates.sh <content-id>" >&2
  exit 2
fi

cd "$ROOT"
npm run compliance:skill:sync -- --check
npm run data:validate
npm run compliance:preaudit -- --content="$CONTENT_ID"
npm run compliance:audit -- --content="$CONTENT_ID"
npm run quality:audit -- --content "$CONTENT_ID"
