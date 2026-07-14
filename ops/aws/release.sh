#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="eventanalysis.org"
DIST_ID="${EVENTANALYSIS_CLOUDFRONT_DISTRIBUTION_ID:-}"
FUNCTION_NAME="${EVENTANALYSIS_CLOUDFRONT_FUNCTION_NAME:-eventanalysis-request-router}"

cd "$ROOT"

npm run lint
npm run data:validate -- --require-private-evidence
npm run quality:calibrate
npm run quality:release
npm test
npm run verify:editorial
npm run verify:prepublish

aws sts get-caller-identity --query 'Arn' --output text >/dev/null

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
UPDATED_ETAG="$(aws cloudfront update-function \
  --name "$FUNCTION_NAME" \
  --if-match "$FUNCTION_ETAG" \
  --function-config 'Comment=EventAnalysis canonical URL and language router,Runtime=cloudfront-js-2.0' \
  --function-code "fileb://ops/aws/cloudfront_request_router.js" \
  --query 'ETag' \
  --output text)"
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

echo "Published EventAnalysis.org; CloudFront invalidation: $INVALIDATION_ID; rollback metadata: $RELEASE_DIR"
