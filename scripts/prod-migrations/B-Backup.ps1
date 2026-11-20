# Step B - full backup of production's public schema (docs/PROD_MIGRATIONS.md s5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\B-Backup.ps1 -Migration v42
#
# READ-ONLY on production (pg_dump: one read-only snapshot, ACCESS SHARE locks,
# gives up after 10s waiting for a lock). Writes a custom-format dump plus a
# .sha256 file to the backups folder, OUTSIDE the repo:
#   default C:\Users\<you>\flash-secrets\backups\
# The file contains customer data. Any copy that leaves this laptop must be
# encrypted first (7-Zip, AES-256, password kept in the password manager).
#
# Retention (asked, never automatic): keep the newest 5 backups, and keep every
# pre-migration backup for at least 30 days. Older ones are listed and deleted
# only if you type DELETE.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Migration,
    [string]$BackupDir = (Join-Path $env:USERPROFILE 'flash-secrets\backups'),
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

Write-FlashStep "Step B ($Migration): backup"
Assert-FlashDocker
$m = Get-FlashMigration -Version $Migration
$p = Get-FlashPaths
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$BackupDir = (Resolve-Path -LiteralPath $BackupDir).Path
if ($BackupDir.StartsWith($p.Root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The backups folder must be outside the repo ($BackupDir is inside $($p.Root))."
}
$tag = if ($Rollback) { 'pre-' + $Migration + '-rollback' } else { 'pre-' + $Migration }
$stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
$name = 'flash_public_' + $stamp + '_' + $tag + '.dump'
Write-Host ("  folder : " + $BackupDir)
Write-Host ("  file   : " + $name)

Read-FlashProdUrl
try {
    Write-FlashStep 'Server check (read-only session)'
    Invoke-FlashProdCheck | Out-Null
    Write-FlashStep 'pg_dump (schema + data of public; read-only)'
    Invoke-FlashContainer -Options @('-e', 'FLASH_PROD_DB_URL', '-v', ($BackupDir + ':/b')) -Image 'postgres:17' -Command @('sh', '/p/backup_public.sh', $name) | Out-Null
} finally {
    Clear-FlashProdUrl
}

$file = Join-Path $BackupDir $name
$size = (Get-Item -LiteralPath $file).Length
if ($size -lt 10000) { throw "backup is only $size bytes; something is wrong" }
$sha = Get-FlashFileSha256 -Path $file
[System.IO.File]::WriteAllText(($file + '.sha256'), ($sha + '  ' + $name + "`n"))
Write-Host ("  sha256 : " + $sha)
Write-Host ("  size   : " + $size + " bytes")

Write-FlashStep 'Retention'
$all = @(Get-ChildItem -LiteralPath $BackupDir -File -Filter 'flash_public_*.dump' | Sort-Object Name -Descending)
$keepNewest = @($all | Select-Object -First 5)
$cutoff = (Get-Date).AddDays(-30)
$old = @($all | Where-Object { ($keepNewest -notcontains $_) -and -not ($_.Name -match '_pre-v\d+' -and $_.LastWriteTime -gt $cutoff) })
Write-Host ("  backups in folder: " + $all.Count + "; kept: newest 5 + pre-migration backups younger than 30 days")
if ($old.Count -gt 0) {
    $old | ForEach-Object { Write-Host ('  old: ' + $_.Name + '  (' + $_.LastWriteTime.ToString('yyyy-MM-dd') + ')') }
    $answer = Read-Host -Prompt ('Delete these ' + $old.Count + ' old backups? Type DELETE to delete, or press Enter to keep them')
    if ($answer -ceq 'DELETE') {
        foreach ($f in $old) {
            foreach ($x in @($f.FullName, ($f.FullName + '.sha256'), ($f.FullName + '.verified'))) {
                if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Force }
            }
        }
        Write-Host '  deleted.'
    } else {
        Write-Host '  kept.'
    }
} else {
    Write-Host '  nothing to prune.'
}

Write-Host ''
Write-Host 'Reminder: encrypt any copy that leaves this laptop (7-Zip, AES-256, password in the password manager).'
Write-Host 'STEP B DONE. Next: step C (verify this backup restores):'
Write-Host ("  powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\C-VerifyBackup.ps1 -Migration " + $Migration + $(if ($Rollback) { ' -Rollback' } else { '' }) + " -Backup `"" + $file + "`"")
