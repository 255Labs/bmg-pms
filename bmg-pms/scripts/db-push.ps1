# Windows version of db-push.sh: applies every migration in order, all in ONE transaction
# (either the whole release lands or nothing does). Each file is safe to re-run, so this is also the upgrade path.
#
# Needs psql (PostgreSQL command line tools):  winget install -e --id PostgreSQL.PostgreSQL.17
# Usage, from the bmg-pms folder in PowerShell:
#   $env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
#   powershell -ExecutionPolicy Bypass -File scripts\db-push.ps1
$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { throw 'Set DATABASE_URL first: $env:DATABASE_URL = "postgresql://..." (Supabase -> Connect -> Session pooler)' }

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  $found = Get-ChildItem 'C:\Program Files\PostgreSQL' -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { throw 'psql not found. Install it: winget install -e --id PostgreSQL.PostgreSQL.17, then open a new PowerShell window.' }
  $psql = $found.FullName
} else { $psql = $psql.Source }

Set-Location (Join-Path $PSScriptRoot '..')
$files = Get-ChildItem 'supabase\migrations\*.sql' | Sort-Object Name
$args = @()
foreach ($f in $files) { Write-Host "-> $($f.Name)"; $args += @('-f', $f.FullName) }
& $psql $env:DATABASE_URL -v ON_ERROR_STOP=1 --single-transaction -q @args
if ($LASTEXITCODE -ne 0) { throw "The database was NOT changed (an error rolled everything back). Read the message above." }
Write-Host 'Database is up to date.'
