#!/usr/bin/env bash
# Apply every migration in order, all in ONE transaction: either the whole release lands or nothing does,
# and there is never a moment where an earlier file's broad grants are live before the hardening in 13 re-applies.
# Each file is safe to re-run, so this is also the upgrade path.
# Usage: DATABASE_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres bash scripts/db-push.sh
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the Supabase connection string (Settings -> Database)}"
cd "$(dirname "$0")/.."
args=()
for f in $(ls supabase/migrations/*.sql | sort); do echo "-> $f"; args+=(-f "$f"); done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -q "${args[@]}"
echo "Database is up to date."
