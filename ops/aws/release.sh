#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="eventanalysis.org"
DIST_ID="${EVENTANALYSIS_CLOUDFRONT_DISTRIBUTION_ID:-}"
FUNCTION_NAME="${EVENTANALYSIS_CLOUDFRONT_FUNCTION_NAME:-eventanalysis-request-router}"
RELEASE_LOCALES_ARG=""
CONTENT_ARG=""

for arg in "$@"; do
  case "$arg" in
    --content=*)
      CONTENT_ARG="$arg"
      ;;
    --locales=*)
      RELEASE_LOCALES_ARG="$arg"
      ;;
  esac
done

if [[ -z "$RELEASE_LOCALES_ARG" && -n "${EVENTANALYSIS_RELEASE_LOCALES:-}" ]]; then
  RELEASE_LOCALES_ARG="--locales=${EVENTANALYSIS_RELEASE_LOCALES}"
fi

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
  PREPARE_ARGS=()
  if [[ -n "$CONTENT_ARG" ]]; then
    PREPARE_ARGS+=("$CONTENT_ARG")
  fi
  if [[ -n "$RELEASE_LOCALES_ARG" ]]; then
    PREPARE_ARGS+=("$RELEASE_LOCALES_ARG")
  fi
  if [[ "${#PREPARE_ARGS[@]}" -gt 0 ]]; then
    npm run release:prepare-locales -- "${PREPARE_ARGS[@]}"
  else
    npm run release:prepare-locales
  fi
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
  COMPLIANCE_ARGS=(--emergency-freeze)
  if [[ -n "$CONTENT_ARG" ]]; then
    COMPLIANCE_ARGS+=("$CONTENT_ARG")
  fi
  if [[ -n "$RELEASE_LOCALES_ARG" ]]; then
    COMPLIANCE_ARGS+=("$RELEASE_LOCALES_ARG")
  else
    :
  fi
  npm run compliance:release -- "${COMPLIANCE_ARGS[@]}"
else
  COMPLIANCE_ARGS=()
  if [[ -n "$CONTENT_ARG" ]]; then
    COMPLIANCE_ARGS+=("$CONTENT_ARG")
  fi
  if [[ -n "$RELEASE_LOCALES_ARG" ]]; then
    COMPLIANCE_ARGS+=("$RELEASE_LOCALES_ARG")
  else
    :
  fi
  if [[ "${#COMPLIANCE_ARGS[@]}" -gt 0 ]]; then
    npm run compliance:release -- "${COMPLIANCE_ARGS[@]}"
  else
    npm run compliance:release
  fi
fi

aws sts get-caller-identity --query 'Arn' --output text >/dev/null
node ops/aws/sync-edge-policy.mjs

if [[ -z "$DIST_ID" ]]; then
  DIST_ID="$(aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='EventAnalysis.org production'].Id | [0]" \
    --output text)"
fi

if [[ -z "$DIST_ID" || "$DIST_ID" == "None" ]]; then
  echo "CloudFront distribution was not found; AWS release stopped before upload." >&2
  exit 1
fi

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
EDGE_TEST_ATTEMPTS=0
until node ops/aws/test-edge-function.mjs --etag="$UPDATED_ETAG"; do
  EDGE_TEST_ATTEMPTS=$((EDGE_TEST_ATTEMPTS + 1))
  if [[ "$EDGE_TEST_ATTEMPTS" -ge 3 ]]; then
    echo "CloudFront development edge tests did not pass after retries." >&2
    exit 1
  fi
  sleep 5
done
aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$UPDATED_ETAG" >/dev/null

aws s3 sync dist/client "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=300" \
  --only-show-errors

INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)"

echo "Waiting for CloudFront invalidation $INVALIDATION_ID..."
aws cloudfront wait invalidation-completed \
  --distribution-id "$DIST_ID" \
  --id "$INVALIDATION_ID"

if ! npm run verify:live:e2e -- \
  --base-url=https://www.eventanalysis.org \
  --report="$RELEASE_DIR/live-e2e-report.json"; then
  echo "Production E2E failed after the first invalidation; retrying once with a fresh invalidation." >&2
  RETRY_INVALIDATION_ID="$(aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text)"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$DIST_ID" \
    --id "$RETRY_INVALIDATION_ID"
  npm run verify:live:e2e -- \
    --base-url=https://www.eventanalysis.org \
    --report="$RELEASE_DIR/live-e2e-report.json"
  INVALIDATION_ID="$RETRY_INVALIDATION_ID"
fi

if [[ "${EA_EMERGENCY_FREEZE:-0}" != "1" && "${EA_SAFETY_TAKEDOWN:-0}" != "1" ]]; then
  trap - EXIT
  rm -rf "$RELEASE_ITEMS_BACKUP"
fi

echo "Published and production-E2E verified EventAnalysis.org; CloudFront invalidation: $INVALIDATION_ID; verification report: $RELEASE_DIR/live-e2e-report.json"
