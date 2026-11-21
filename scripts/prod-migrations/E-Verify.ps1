# Step E - READ-ONLY verification after step D (docs/PROD_MIGRATIONS.md s5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\E-Verify.ps1 -Migration v42
#   (add -Rollback after a rollback)
#
# Passes only if production's normalized schema fingerprint now equals the
# migration's AFTER fingerprint, which must also equal sha256 of the committed
# baseline (scripts/schema-baseline/production_schema_baseline.sql), and the
# ledger records this file's sha256. With -Rollback: production must equal
# BEFORE and the ledger must not record the migration.
# Prints a block to paste into the PR / docs/SCHEMA_BASELINE.md history.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Migration,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

Write-FlashStep "Step E ($Migration$(if ($Rollback) { ' rollback' } else { '' })): read-only verification"
Assert-FlashDocker
$p = Get-FlashPaths
$m = Get-FlashMigration -Version $Migration
$expected = if ($Rollback) { $m.Before } else { $m.After }
$work = Get-FlashWorkDir -Version $Migration
$rawName = if ($Rollback) { 'rollback_after_raw.sql' } else { 'after_raw.sql' }

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
$fp = Get-FlashFingerprint -WorkDir $work -InName $rawName -OutName ($rawName -replace '_raw\.sql$', '_normalized.sql')
Write-Host ("  production now : " + $fp.Sha + "  (" + $fp.Bytes + " bytes, " + $fp.Tables + " CREATE TABLEs)")
$baselineSha = Get-FlashFileSha256 -Path $p.Baseline
$rows = @($ledger | Where-Object { $_ -match ('^row\|' + $Migration + '\|') })

if ($Rollback) {
    Write-FlashCheck 'production == BEFORE fingerprint' ($fp.Sha -eq $m.Before) ($fp.Sha + ' vs ' + $m.Before)
    Write-FlashCheck "ledger no longer records $Migration" ($rows.Count -eq 0)
    Write-Host ''
    Write-Host 'STEP E PASSED (rollback). The committed baseline is now ahead of production: revert the migration PR before anything else.'
    return
}

Write-FlashCheck 'production == AFTER fingerprint' ($fp.Sha -eq $m.After) ($fp.Sha + ' vs ' + $m.After)
Write-FlashCheck 'AFTER == committed baseline' ($baselineSha -eq $m.After) $baselineSha
Write-FlashCheck "ledger has exactly one $Migration row" ($rows.Count -eq 1)
$parts = $rows[0] -split '\|'
Write-FlashCheck 'ledger sha256 == this file' ($parts[2] -eq $m.Sha) $parts[2]

$summary = @(
    ('migration      : ' + $m.FileName),
    ('file sha256    : ' + $m.Sha),
    ('ledger         : ' + $parts[1] + ' ' + $parts[2] + ' applied_at ' + $parts[3]),
    ('before (A)     : ' + $m.Before),
    ('after (E)      : ' + $fp.Sha + ' (' + $fp.Bytes + ' bytes, ' + $fp.Tables + ' CREATE TABLEs)'),
    ('verified (SAST): ' + (Get-FlashSastNow).ToString('yyyy-MM-dd HH:mm'))
)
[System.IO.File]::WriteAllLines((Join-Path $work 'E-summary.txt'), [string[]]$summary)
Write-Host ''
$summary | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host 'STEP E PASSED. Production == committed baseline == BEFORE + this migration. Paste the block above into the PR.'
Write-Host ''
Write-Host 'Last part of step E (PROD_MIGRATIONS.md rule 10): open Supabase -> Advisors -> Security, refresh it, and record'
Write-Host 'the date and the remaining lints (name and count) in the PR. A new ERROR or WARN from this migration = step E failed.'
