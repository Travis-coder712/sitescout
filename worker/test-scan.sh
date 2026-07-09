#!/usr/bin/env bash
# Quick local test: send a real photo to the locally-running Worker and print
# the structured hazard JSON. Proves the whole AI path before deploying.
#
# Usage:
#   1. Terminal A:  cd worker && npx wrangler dev        (starts http://localhost:8787)
#   2. Terminal B:  cd worker && ./test-scan.sh ~/path/to/site-photo.jpg
#
# Set WORKER_URL to test against a deployed Worker instead of localhost.
set -euo pipefail

IMG="${1:-}"
if [ -z "$IMG" ] || [ ! -f "$IMG" ]; then
  echo "Usage: ./test-scan.sh path/to/photo.jpg [\"optional note\"]"
  exit 1
fi
if [ ! -f .dev.vars ]; then
  echo "Missing worker/.dev.vars — copy .dev.vars.example to .dev.vars and fill it in."
  exit 1
fi

ACCESS_CODE=$(grep -E '^ACCESS_CODE=' .dev.vars | cut -d= -f2- | tr -d '\042\047')  # strip " and '
URL="${WORKER_URL:-http://localhost:8787}"
MIME=$(file --mime-type -b "$IMG")
NOTE="${2:-Local test scan}"
B64=$(base64 < "$IMG" | tr -d '\n')   # base64 is JSON-safe (no quotes/backslashes)

printf '{"mode":"scan","media_type":"%s","note":"%s","image":"%s"}' "$MIME" "$NOTE" "$B64" > /tmp/sitescout_payload.json

echo "→ POST $URL  (image: $IMG, $MIME)"
curl -s -X POST "$URL" \
  -H "content-type: application/json" \
  -H "x-sitescout-access: $ACCESS_CODE" \
  --data @/tmp/sitescout_payload.json | { jq . 2>/dev/null || cat; }
echo
rm -f /tmp/sitescout_payload.json
