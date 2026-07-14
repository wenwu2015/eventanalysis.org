#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="eventanalysis.org"
DIST_ID="${EVENTANALYSIS_CLOUDFRONT_DISTRIBUTION_ID:-}"

cd "$ROOT"

npm run lint
npm test

aws s3 sync dist/client "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=300" \
  --only-show-errors

aws s3 sync dist/client/assets "s3://$BUCKET/assets" \
  --cache-control "public,max-age=31536000,immutable" \
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

echo "Published EventAnalysis.org; CloudFront invalidation: $INVALIDATION_ID"
