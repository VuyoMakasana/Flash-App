# Step C - prove the backup restores (docs/PROD_MIGRATIONS.md s5). LOCAL ONLY.
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\C-VerifyBackup.ps1 -Migration v42 -Backup "C:\Users\<you>\flash-secrets\backups\flash_public_....dump"
#
# Never asks for the production connection string and never connects to it.
# Restores the backup into a throwaway postgres:17 container started with
# --network none and in-memory storage (removed at the end), prints the table
# count and every table's row count, and checks that the backup holds the
# schema step A saw: step A's schema dump (which matched BEFORE, or AFTER with
# -Rollback) is restored the same way, and the two restored schemas must be
# identical. (A restored copy re-spells some CHECK expressions, so a restored
# schema is compared with another restored schema, never with production's
# fingerprint directly.) On success writes <backup>.verified, which step D
# requires.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Migration,
    [Parameter(Mandatory = $true)][string]$Backup,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

Write-FlashStep "Step C ($Migration): verify the backup restores (local only)"
Assert-FlashDocker
$m = Get-FlashMigration -Version $Migration
$expected = if ($Rollback) { $m.After } else { $m.Before }
$Backup = (Resolve-Path -LiteralPath $Backup).Path
$dir = Split-Path -Parent $Backup
$name = Split-Path -Leaf $Backup
$sidecar = $Backup + '.sha256'
if (-not (Test-Path -LiteralPath $sidecar)) { throw "missing $sidecar (made by step B)" }
$recorded = ([System.IO.File]::ReadAllText($sidecar).Trim() -split '\s+')[0]
$sha = Get-FlashFileSha256 -Path $Backup
Write-FlashCheck 'backup sha256 matches its .sha256 file' ($sha -eq $recorded) $sha

$work = Get-FlashWorkDir -Version $Migration
$p = Get-FlashPaths
$markerName = if ($Rollback) { 'A.rollback.passed' } else { 'A.passed' }
$a = Read-FlashMarker -Path (Join-Path $work $markerName)
Write-FlashCheck 'step A passed first' ($null -ne $a)
Write-FlashCheck 'step A saw the expected fingerprint' ($a['fingerprint'] -eq $expected)
$pg = $null
try {
    $pg = Start-FlashLocalPg -Mounts @(($dir + ':/b:ro'), ($p.Runbook + ':/p:ro'), ($work + ':/work'))
    Write-Host ("  local container: " + $pg + " (no network)")
    Invoke-FlashDocker @('exec', $pg, 'sh', '/p/verify_backup.sh', ('/b/' + $name), ('/work/' + $a['raw_dump'])) | ForEach-Object { Write-Host ('  ' + $_) }
} finally {
    Stop-FlashLocalPg -Name $pg
}

$fp = Get-FlashFingerprint -WorkDir $work -InName 'backup_schema_raw.sql' -OutName 'backup_schema_normalized.sql'
$fa = Get-FlashFingerprint -WorkDir $work -InName 'step_a_restored_raw.sql' -OutName 'step_a_restored_normalized.sql'
Write-Host ("  restored backup schema : " + $fp.Sha + "  (" + $fp.Bytes + " bytes, " + $fp.Tables + " CREATE TABLEs)")
Write-Host ("  restored step A schema : " + $fa.Sha + "  (" + $fa.Bytes + " bytes, " + $fa.Tables + " CREATE TABLEs)")
Write-FlashCheck 'backup schema == the schema step A saw (both restored the same way)' ($fp.Sha -eq $fa.Sha)

Confirm-FlashTyped -Expected 'yes' -Prompt 'Do the table count and row counts above look right for production'
Write-FlashMarker -Path ($Backup + '.verified') -Data @{ migration = $Migration; backup_sha = $sha; step_a_fingerprint = $a['fingerprint']; restored_schema = $fp.Sha; mode = $(if ($Rollback) { 'rollback' } else { 'apply' }) }
Write-Host ''
Write-Host 'STEP C PASSED. The backup restores. Next: second review of the SQL, then step D.'
