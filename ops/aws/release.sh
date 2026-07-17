#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="eventanalysis.org"
DIST_ID="${EVENTANALYSIS_CLOUDFRONT_DISTRIBUTION_ID:-}"
FUNCTION_NAME="${EVENTANALYSIS_CLOUDFRONT_FUNCTION_NAME:-eventanalysis-request-router}"

cd "$ROOT"

if [[ "${EA_EMERGENCY_FREEZE:-0}" != "1" && "${EA_SAFETY_TAKEDOWN:-0}" != "1" && "${1:-}" != "--confirm-production" ]]; then
  echo "AWS publication is manual-only. Review the local preview, then run: npm run release:aws -- --confirm-production" >&2
  exit 64
fi

npm run compliance:skill:sync -- --check
if [[ "${EA_EMERGENCY_FREEZE:-0}" != "1" && "${EA_SAFETY_TAKEDOWN:-0}" != "1" ]]; then
  RELEASE_ITEMS_BACKUP="$(mktemp -d)"
  cp -R content/data/items "$RELEASE_ITEMS_BACKUP/items"
  restore_items_on_failure() {
    local status=$?
    if [[ "$status" -ne 0 ]]; then
      rm -rf content/data/items
      cp -R "$RELEASE_ITEMS_BACKUP/items" content/data/items
    fi
    rm -rf "$RELEASE_ITEMS_BACKUP"
    exit "$status"
  }
  trap restore_items_on_failure EXIT
  npm run release:prepare-locales
fi
npm run lint
npm run data:validate
npm run quality:calibrate
if [[ "${EA_EMERGENCY_FREEZE:-0}" != "1" ]]; then
  npm run data:validate -- --require-private-evidence
  npm run quality:release
fi
npm test
npm run verify:editorial
npm run verify:prepublish
if [[ "${EA_EMERGENCY_FREEZE:-0}" == "1" ]]; then
  npm run compliance:release -- --emergency-freeze
else
  npm run compliance:release
fi

aws sts get-caller-identity --query 'Arn' --output text >/dev/null
node ops/aws/sync-edge-policy.mjs

RELEASE_DIR="pipeline/runtime/aws-release/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RELEASE_DIR"
git rev-parse HEAD > "$RELEASE_DIR/git-commit.txt"
aws s3api list-objects-v2 --bucket "$BUCKET" --query 'Contents[].{Key:Key,ETag:ETag,Size:Size}' > "$RELEASE_DIR/s3-before.json"

aws s3 sync dist/client "s3://$BUCKET" \
  --cache-control "public,max-age=300" \
  --only-show-errors

aws s3 sync dist/client/assets "s3://$BUCKET/assets" \
  --cache-control "public,max-age=31536000,immutable" \
  --only-show-errors

FUNCTION_ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --stage DEVELOPMENT --query 'ETag' --output text)"
KVS_ARN="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("pipeline/runtime/compliance/edge-store.json","utf8")).arn)')"
FUNCTION_CONFIG="pipeline/runtime/compliance/cloudfront-function-config.json"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify({Comment:"EventAnalysis canonical router and fail-closed publication guard",Runtime:"cloudfront-js-2.0",KeyValueStoreAssociations:{Quantity:1,Items:[{KeyValueStoreARN:process.argv[1]}]}}))' "$KVS_ARN" "$FUNCTION_CONFIG"
UPDATED_ETAG="$(aws cloudfront update-function \
  --name "$FUNCTION_NAME" \
  --if-match "$FUNCTION_ETAG" \
  --function-config "file://$FUNCTION_CONFIG" \
  --function-code "fileb://ops/aws/cloudfront_request_router.js" \
  --query 'ETag' \
  --output text)"
node ops/aws/test-edge-function.mjs --etag="$UPDATED_ETAG"
aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$UPDATED_ETAG" >/dev/null

aws s3 sync dist/client "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=300" \
  --only-show-errors

if [[ -z "$DIST_ID" ]]; then
  DIST_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='EventAnalysis.org production'].Id | [0]" \
    --output text)"
fi

if [[ -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  echo "CloudFront distribution was not found; S3 upload completed." >&2
  exit 1
fi

INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)"

if [[ "${EA_EMERGENCY_FREEZE:-0}" != "1" && "${EA_SAFETY_TAKEDOWN:-0}" != "1" ]]; then
  trap - EXIT
  rm -rf "$RELEASE_ITEMS_BACKUP"
fi

echo "Published EventAnalysis.org; CloudFront invalidation: $INVALIDATION_ID; rollback metadata: $RELEASE_DIR"
