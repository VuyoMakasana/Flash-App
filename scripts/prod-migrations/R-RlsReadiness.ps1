# R-RlsReadiness.ps1 - READ-ONLY readiness check for v43 (RLS on public, FI-081, #73).
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\R-RlsReadiness.ps1 -BackendRole postgres
#
# -BackendRole: the database role the BACKEND connects as. Take it from the
# user part of Render's DATABASE_URL for Flash-App (postgresql://USER:...@host):
# with the Supabase pooler the user looks like postgres.<project-ref>; the
# role is the part before the dot (postgres). Type only the role name.
#
# Asks for the Session pooler connection string (Read-Host -AsSecureString),
# runs scripts/prod-migrations/rls_readiness.sh in a postgres:17 container in
# a READ-ONLY session (catalog reads only: no table data, no locks on
# application tables), prints and saves the result, and clears the string.
#
# It answers: if RLS were enabled with no policies on every table in public,
# would the backend role still read and write every table? That holds only if
# the role is a superuser or has BYPASSRLS, or has its owner's privileges on
# every table (and none has FORCE ROW LEVEL SECURITY).
# VERDICT OK   -> v43 can be written as proposed.
# VERDICT STOP -> the listed tables would become unreadable to the backend.
#                 Do not proceed; send the output.
#
# -PostV43: the v43-specific check after step E (docs/PROD_MIGRATIONS.md s5).
# The schema fingerprint cannot see grants (pg_dump --no-privileges), so this
# proves the other half of v43. PASS only if rls_enabled = 67, no table,
# sequence or function in public is granted to anon/authenticated, postgres's
# default privileges no longer mention them, and the verdict is OK.
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\R-RlsReadiness.ps1 -BackendRole postgres -PostV43
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackendRole,
    [switch]$PostV43
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

Write-FlashStep 'RLS readiness (read-only)'
if ($BackendRole -cnotmatch '^[a-z_][a-z0-9_]*$') { throw "BackendRole must be a plain role name such as postgres (got '$BackendRole')." }
Assert-FlashDocker
$work = Get-FlashWorkDir -Version 'v43'

Read-FlashProdUrl
try {
    Write-FlashStep 'Server check (read-only session)'
    Invoke-FlashProdCheck | Out-Null
    Write-FlashStep ('Catalog read for backend role ' + $BackendRole)
    $env:FLASH_BACKEND_ROLE = $BackendRole
    $r = Invoke-FlashContainer -Quiet -Options @('-e', 'FLASH_PROD_DB_URL', '-e', 'FLASH_BACKEND_ROLE') -Image 'postgres:17' -Command @('sh', '/p/rls_readiness.sh')
} finally {
    Remove-Item Env:FLASH_BACKEND_ROLE -ErrorAction SilentlyContinue
    Clear-FlashProdUrl
}

$out = Join-Path $work $(if ($PostV43) { 'rls_post_v43.txt' } else { 'rls_readiness.txt' })
[System.IO.File]::WriteAllLines($out, [string[]]$r.Output)
foreach ($l in $r.Output) {
    if ($l -match '^(session|role|owners|summary|verdict|default_acl|sequence|function)\|') { Write-Host ('  ' + $l) }
}
$tables = @($r.Output | Where-Object { $_ -like 'table|*' })
Write-Host ('  table lines: ' + $tables.Count + ' (all in ' + $out + ')')
$notExempt = @($tables | Where-Object { ($_ -split '\|')[6] -ne 't' })
foreach ($l in $notExempt) { Write-Host ('  NOT EXEMPT: ' + $l) }

$verdict = @($r.Output | Where-Object { $_ -like 'verdict|*' })
Write-Host ''
if ($verdict.Count -eq 1 -and $verdict[0] -like 'verdict|OK*') {
    Write-Host 'VERDICT OK: the backend role would keep full access with RLS on. Send the saved file.'
} else {
    Write-Host 'VERDICT STOP: the backend role would lose access to the tables above. Do not proceed; send the saved file.'
}
Write-Host ('Saved (table names and role names only, no data, no secrets): ' + $out)

if ($PostV43) {
    Write-FlashStep 'v43 post-check (after step E)'
    $check = Test-FlashV43Lockdown -Lines $r.Output -ExpectedTables 67
    foreach ($f in $check.Failures) { Write-Host ('  [FAIL] ' + $f) }
    $other = @($r.Output | Where-Object { $_ -like 'default_acl|*' -and $_ -notlike 'default_acl|postgres|*' })
    foreach ($l in $other) { Write-Host ('  (accepted gap, not checked) ' + $l) }
    Write-Host ''
    if ($check.Pass) {
        Write-Host 'V43 POST-CHECK PASSED: RLS on all 67 tables; anon/authenticated hold nothing in public; postgres defaults clean; backend keeps access.'
    } else {
        Write-Host 'V43 POST-CHECK FAILED: see the [FAIL] lines above. Step E is not complete; send the saved file.'
        exit 1
    }
}
