# Step A - READ-ONLY checks against production (docs/PROD_MIGRATIONS.md s5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\A-ReadOnlyChecks.ps1 -Migration v42
#   (add -Rollback when preparing a rollback: production must then match AFTER)
#
# Reads only: server check in a read-only session, a schema-only dump, the
# migration ledger. Writes nothing to production. Passes only if production's
# normalized schema fingerprint equals the migration's BEFORE fingerprint
# (AFTER with -Rollback). Leaves the raw dump in schema-baseline-input\<vNN>\
# for step D's local rehearsal.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Migration,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

Write-FlashStep "Step A ($Migration$(if ($Rollback) { ' rollback' } else { '' })): read-only checks"
Assert-FlashDocker
$m = Get-FlashMigration -Version $Migration
$expected = if ($Rollback) { $m.After } else { $m.Before }
$expectedName = if ($Rollback) { 'AFTER' } else { 'BEFORE' }
Write-Host ("  migration file : " + $m.FileName + "  sha256 " + $m.Sha + " (matches SHA256SUMS)")
Write-Host ("  expected now   : " + $expectedName + " " + $expected)
$work = Get-FlashWorkDir -Version $Migration
$rawName = if ($Rollback) { 'rollback_before_raw.sql' } else { 'before_raw.sql' }

Read-FlashProdUrl
try {
    Write-FlashStep 'Server check (read-only session)'
    Invoke-FlashProdCheck | Out-Null
    Write-FlashStep 'Schema-only dump (no table data)'
    Invoke-FlashProdSchemaDump -WorkDir $work -Name $rawName | Out-Null
    Write-FlashStep 'Migration ledger (read-only)'
    $ledger = Invoke-FlashLedgerRead
} finally {
    Clear-FlashProdUrl
}

Write-FlashStep 'Fingerprint'
$normName = $rawName -replace '_raw\.sql$', '_normalized.sql'
$fp = Get-FlashFingerprint -WorkDir $work -InName $rawName -OutName $normName
Write-Host ("  production now : " + $fp.Sha + "  (" + $fp.Bytes + " bytes, " + $fp.Tables + " CREATE TABLEs)")

$ledgerText = $ledger -join "`n"
$hasRow = $ledgerText -match ("(?m)^row\|" + $Migration + "\|")
if ($Rollback) {
    Write-FlashCheck "ledger records $Migration" $hasRow
} else {
    Write-FlashCheck "ledger does not record $Migration yet" (-not $hasRow)
}
Write-FlashCheck ("production == " + $expectedName + " fingerprint") ($fp.Sha -eq $expected) ($fp.Sha + ' vs ' + $expected)

$marker = Join-Path $work $(if ($Rollback) { 'A.rollback.passed' } else { 'A.passed' })
Write-FlashMarker -Path $marker -Data @{ migration = $Migration; mode = $(if ($Rollback) { 'rollback' } else { 'apply' }); fingerprint = $fp.Sha; file_sha = $m.Sha; raw_dump = $rawName }
Write-Host ''
Write-Host "STEP A PASSED. Production matches $expectedName. Next: step B (backup)."
