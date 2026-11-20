# Step D - apply ONE migration file to production (docs/PROD_MIGRATIONS.md s5).
# THE ONLY STEP THAT WRITES TO PRODUCTION.
#
#   powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\D-Apply.ps1 -Migration v42 -Backup "C:\Users\<you>\flash-secrets\backups\flash_public_....dump"
#   (-Rollback applies the reviewed rollback file instead; only on your explicit decision)
#
# Refuses unless ALL of these hold, in this order (nothing touches production
# until every one has passed):
#   1. git: no tracked changes, no untracked files under backend/src/db/migrations
#      or scripts/, on branch main, and local main == origin/main after a fetch;
#   2. the file's sha256 == SHA256SUMS == the value you paste from the merged PR;
#   3. you paste the link to the second review of this SQL;
#   4. step A passed in the last 12 hours, and step C verified a backup of the
#      same schema in the last 24 hours;
#   5. a local rehearsal on step A's dump of production (no network) produces
#      exactly the AFTER fingerprint (BEFORE with -Rollback), a second run is a
#      no-op, and a wrong file_sha is refused;
#   6. you type the confirmation;
#   7. production, re-checked just before applying, still matches BEFORE
#      (AFTER with -Rollback).
# Then psql applies the file in ONE transaction with ON_ERROR_STOP: the first
# error rolls back everything. lock_timeout 5s / statement_timeout 60s are set
# inside the file, so it gives up instead of queueing behind live traffic.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Migration,
    [Parameter(Mandatory = $true)][string]$Backup,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FlashMigration.psm1') -Force

$mode = if ($Rollback) { 'ROLLBACK' } else { 'APPLY' }
Write-FlashStep "Step D ($Migration): $mode - pre-checks (nothing touches production yet)"
Assert-FlashDocker
$p = Get-FlashPaths
$m = Get-FlashMigration -Version $Migration
if ($Rollback) {
    $sqlPath = $m.RollbackPath; $sqlSha = $m.RollbackSha; $sqlRel = 'rollback/' + $m.RollbackName
    $expectedNow = $m.After; $expectedEnd = $m.Before; $markerName = 'A.rollback.passed'; $rawName = 'rollback_before_raw.sql'
} else {
    $sqlPath = $m.Path; $sqlSha = $m.Sha; $sqlRel = $m.FileName
    $expectedNow = $m.Before; $expectedEnd = $m.After; $markerName = 'A.passed'; $rawName = 'before_raw.sql'
}
Write-Host ("  file   : backend/src/db/migrations/" + $sqlRel)
Write-Host ("  sha256 : " + $sqlSha + " (matches SHA256SUMS)")

# 1. git
Write-FlashStep '1. Git checks'
function Invoke-FlashGit { $o = & git -C $p.Root @args; if ($LASTEXITCODE -ne 0) { throw "git $args failed" }; return $o }
$dirty = @(Invoke-FlashGit status --porcelain --untracked-files=no)
Write-FlashCheck 'no tracked changes in the working tree' ($dirty.Count -eq 0) ($dirty -join '; ')
$untracked = @(Invoke-FlashGit status --porcelain --untracked-files=all -- backend/src/db/migrations scripts)
Write-FlashCheck 'no untracked files under backend/src/db/migrations or scripts/' ($untracked.Count -eq 0) ($untracked -join '; ')
$branch = (Invoke-FlashGit rev-parse --abbrev-ref HEAD) -join ''
Write-FlashCheck 'on branch main' ($branch -eq 'main') $branch
Invoke-FlashGit fetch --quiet origin main | Out-Null
$head = (Invoke-FlashGit rev-parse HEAD) -join ''
$origin = (Invoke-FlashGit rev-parse origin/main) -join ''
Write-FlashCheck 'local main == origin/main' ($head -eq $origin) ($head + ' vs ' + $origin)
Invoke-FlashGit ls-files --error-unmatch -- ('backend/src/db/migrations/' + $sqlRel) | Out-Null
Write-FlashCheck 'the file is tracked in git' $true

# 2. sha256 recorded in the merged PR
Write-FlashStep '2. File hash vs the merged PR'
$prSha = (Read-Host -Prompt ('Paste the sha256 of ' + $sqlRel + ' from the merged PR description')).Trim().ToLowerInvariant()
Write-FlashCheck 'sha256 == value in the merged PR' ($prSha -eq $sqlSha) ($sqlSha + ' vs ' + $prSha)

# 3. second review
Write-FlashStep '3. Second review'
$review = (Read-Host -Prompt 'Paste the link to the second review of this SQL (GitHub review or comment)').Trim()
Write-FlashCheck 'second review link given' ($review -match '^https://github\.com/\S+$') $review

# 4. step A and step C evidence
Write-FlashStep '4. Step A and step C evidence'
$work = Get-FlashWorkDir -Version $Migration
$a = Read-FlashMarker -Path (Join-Path $work $markerName)
Write-FlashCheck 'step A passed' ($null -ne $a)
Write-FlashCheck 'step A saw the expected fingerprint and this file' (($a['fingerprint'] -eq $expectedNow) -and ($a['file_sha'] -eq $m.Sha))
Write-FlashCheck 'step A is less than 12 hours old' ((Get-FlashMarkerAgeHours $a) -lt 12)
$Backup = (Resolve-Path -LiteralPath $Backup).Path
$c = Read-FlashMarker -Path ($Backup + '.verified')
Write-FlashCheck 'step C verified this backup' ($null -ne $c)
Write-FlashCheck 'the backup file is unchanged since step C' ((Get-FlashFileSha256 -Path $Backup) -eq $c['backup_sha'])
Write-FlashCheck 'the backup is of the schema step A saw' ($c['step_a_fingerprint'] -eq $expectedNow)
Write-FlashCheck 'step C is less than 24 hours old' ((Get-FlashMarkerAgeHours $c) -lt 24)
# The expected change is BEFORE -> AFTER, as normalized files:
#   BEFORE = step A's normalized dump (it matched the BEFORE fingerprint);
#   AFTER  = the committed baseline (it must match the AFTER fingerprint).
# With -Rollback: AFTER = step A -Rollback's dump, BEFORE = the original
# step A's dump, which must still be in the work folder.
$beforeFile = Join-Path $work 'before_normalized.sql'
Write-FlashCheck 'BEFORE schema file present (from step A)' (Test-Path -LiteralPath $beforeFile)
Write-FlashCheck 'BEFORE schema file == BEFORE fingerprint' ((Get-FlashFileSha256 -Path $beforeFile) -eq $m.Before)
if ($Rollback) {
    $afterRef = 'rollback_before_normalized.sql'
    Write-FlashCheck 'AFTER schema file == AFTER fingerprint' ((Get-FlashFileSha256 -Path (Join-Path $work $afterRef)) -eq $m.After)
} else {
    $afterRef = 'BASELINE'
    Write-FlashCheck 'committed baseline == AFTER fingerprint' ((Get-FlashFileSha256 -Path $p.Baseline) -eq $m.After)
}

# 5. local rehearsal
Write-FlashStep '5. Local rehearsal on production''s schema (no network)'
$pg = $null
try {
    $pg = Start-FlashLocalPg -Mounts @(($work + ':/work'), ($p.Migrations + ':/m:ro'), ($p.Runbook + ':/p:ro'))
    $rehearseArgs = @('exec', $pg, 'sh', '/p/rehearse.sh', ('/work/' + $rawName), ('/m/' + $m.FileName), $m.Sha, ('/m/rollback/' + $m.RollbackName))
    Invoke-FlashDocker $rehearseArgs | ForEach-Object { Write-Host ('  ' + $_) }
} finally {
    Stop-FlashLocalPg -Name $pg
}
$r0 = Get-FlashFingerprint -WorkDir $work -InName 'rehearsal_before.sql' -OutName 'rehearsal_before_normalized.sql'
$r1 = Get-FlashFingerprint -WorkDir $work -InName 'rehearsal_after_1.sql' -OutName 'rehearsal_after_1_normalized.sql'
$r2 = Get-FlashFingerprint -WorkDir $work -InName 'rehearsal_after_2.sql' -OutName 'rehearsal_after_2_normalized.sql'
$r3 = Get-FlashFingerprint -WorkDir $work -InName 'rehearsal_after_3.sql' -OutName 'rehearsal_after_3_normalized.sql'
$rb = Get-FlashFingerprint -WorkDir $work -InName 'rehearsal_rolled_back.sql' -OutName 'rehearsal_rolled_back_normalized.sql'
Write-FlashCheck 'rehearsal: second apply changes nothing' ($r2.Sha -eq $r1.Sha)
Write-FlashCheck 'rehearsal: refused wrong file_sha changed nothing' ($r3.Sha -eq $r1.Sha)
if ($Rollback) {
    Write-FlashCheck 'rehearsal: re-applying on the AFTER schema is a no-op' ($r1.Sha -eq $r0.Sha)
    Write-Host '  rollback change on the local copy vs the expected change AFTER -> BEFORE:'
    Write-FlashCheck 'rehearsal: rollback makes exactly the change AFTER -> BEFORE' (Test-FlashSchemaDelta -WorkDir $work -Mode 'same-delta' -Files @('rehearsal_before_normalized.sql', 'rehearsal_rolled_back_normalized.sql', $afterRef, 'before_normalized.sql'))
} else {
    Write-Host '  migration change on the local copy vs the expected change BEFORE -> AFTER:'
    Write-FlashCheck 'rehearsal: apply makes exactly the change BEFORE -> AFTER' (Test-FlashSchemaDelta -WorkDir $work -Mode 'same-delta' -Files @('rehearsal_before_normalized.sql', 'rehearsal_after_1_normalized.sql', 'before_normalized.sql', $afterRef))
    Write-FlashCheck 'rehearsal: rollback returns exactly to the start' ($rb.Sha -eq $r0.Sha)
}

# 6. confirmation
Write-FlashStep '6. Confirmation'
$sast = Get-FlashSastNow
$minutes = $sast.Hour * 60 + $sast.Minute
Write-Host ("  time now (SAST): " + $sast.ToString('yyyy-MM-dd HH:mm'))
if ($minutes -lt (6 * 60 + 45) -or $minutes -gt (19 * 60 + 45)) {
    Write-Host '  WARNING: outside the 06:45-19:45 SAST awake window (the service may be asleep).'
    Confirm-FlashTyped -Expected 'OUTSIDE WINDOW' -Prompt 'Continue outside the window'
}
Write-Host '  Choose a quiet time: no orders in flight. A lock wait gives up after 5 seconds.'
Confirm-FlashTyped -Expected ($mode + ' ' + $Migration) -Prompt ('Apply ' + $sqlRel + ' to PRODUCTION now')

# 7. production
Read-FlashProdUrl
$applied = $false
try {
    Write-FlashStep '7a. Server check (read-only session)'
    Invoke-FlashProdCheck | Out-Null
    Write-FlashStep '7b. Production still matches the expected schema'
    Invoke-FlashProdSchemaDump -WorkDir $work -Name 'd_precheck_raw.sql' | Out-Null
    $now = Get-FlashFingerprint -WorkDir $work -InName 'd_precheck_raw.sql' -OutName 'd_precheck_normalized.sql'
    Write-FlashCheck 'production == expected fingerprint, re-checked now' ($now.Sha -eq $expectedNow) ($now.Sha)
    Write-FlashStep ('7c. ' + $mode + ' (one transaction)')
    $r = Invoke-FlashContainer -AllowFailure -Options @('-e', 'FLASH_PROD_DB_URL', '-e', ('FLASH_SQL_FILE=/m/' + $sqlRel), '-e', ('FLASH_FILE_SHA=' + $sqlSha), '-e', 'FLASH_CONFIRM=yes-apply', '-v', ($p.Migrations + ':/m:ro')) -Image 'postgres:17' -Command @('sh', '/p/apply_migration.sh')
    $code = $r.Code
    if ($code -ne 0) {
        Write-Host ''
        Write-Host 'APPLY FAILED. psql ran in one transaction with ON_ERROR_STOP, so NOTHING was applied.'
        Write-Host 'Copy the error text above (it contains no secrets) and send it for review.'
        throw "apply failed (exit $code)"
    }
    $applied = $true
} finally {
    Clear-FlashProdUrl
}

Write-FlashMarker -Path (Join-Path $work $(if ($Rollback) { 'D.rollback.applied' } else { 'D.applied' })) -Data @{ migration = $Migration; mode = $mode; file = $sqlRel; file_sha = $sqlSha; review = $review; git_head = $head; backup = $Backup }
Write-Host ''
Write-Host ("STEP D DONE: " + $sqlRel + " committed on production.")
Write-Host ("Next, now: powershell -ExecutionPolicy Bypass -File scripts\prod-migrations\E-Verify.ps1 -Migration " + $Migration + $(if ($Rollback) { ' -Rollback' } else { '' }))
