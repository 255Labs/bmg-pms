#!/usr/bin/env bash
# Deploy all Edge Functions. JWT checks are set per function in supabase/config.toml.
# Usage: SUPABASE_PROJECT_REF=<ref> bash scripts/deploy-functions.sh   (after `supabase login`, or with SUPABASE_ACCESS_TOKEN)
set -euo pipefail
: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF}"
cd "$(dirname "$0")/.."
for fn in channex-sync channex-webhook ttlock-sync hikvision-ingest fiscal-sync pos-gateway payments-sync clickpesa-webhook sms-sync email-sync integration-catalog quickbooks-oauth quickbooks-sync; do
  echo "-> $fn"
  supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF"
done
echo "Functions deployed. Secrets are not touched; set them once with: supabase secrets set NAME=value --project-ref $SUPABASE_PROJECT_REF"
