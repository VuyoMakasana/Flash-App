# FlashMigration.psm1 - shared helpers for the production migration runbook
# (docs/PROD_MIGRATIONS.md, L0.2 #71). Imported by A-..E- scripts.
#
# Rules this module enforces for every step:
#  - Everything runs through `docker run` (postgres:17 / python:3.12-alpine).
#    Nothing here needs a Unix shell or a scripting runtime on the Windows host.
#  - The production connection string is read ONLY by Read-FlashProdUrl, with
#    Read-Host -AsSecureString, held in this process's environment for the
#    duration of the step, passed to docker by NAME (-e FLASH_PROD_DB_URL, so it
#    never appears on a command line), and removed by Clear-FlashProdUrl.
#  - It is never printed. Only "pooler host: yes/no" is shown.
#  - Importing this module has no side effects.
Set-StrictMode -Version 2.0

$script:PgImage = 'postgres:17'
$script:PyImage = 'python:3.12-alpine'

function Get-FlashRepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-FlashPaths {
    $root = Get-FlashRepoRoot
    return [pscustomobject]@{
        Root        = $root
        Migrations  = Join-Path $root 'backend\src\db\migrations'
        SchemaTools = Join-Path $root 'scripts\schema-baseline'
        Runbook     = Join-Path $root 'scripts\prod-migrations'
        Baseline    = Join-Path $root 'scripts\schema-baseline\production_schema_baseline.sql'
        InputDir    = Join-Path $root 'schema-baseline-input'
    }
}

# THE hash: lowercase hex sha256 over the exact file bytes. migrate.js computes
# the same value with Node crypto (backend/src/db/migrationFile.js); the unit
# test tests/unit/migrationFile.test.js proves both agree.
function Get-FlashFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Read-FlashChecksums {
    $p = Get-FlashPaths
    $sums = @{}
    foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $p.Migrations 'SHA256SUMS'))) {
        if ($line.Trim() -eq '') { continue }
        if ($line -notmatch '^([0-9a-f]{64}) [ *](\S+)$') { throw "malformed SHA256SUMS line: $line" }
        $sums[$Matches[2]] = $Matches[1]
    }
    return $sums
}

function Get-FlashHeaderValue {
    param([string]$Text, [string]$Key)
    $m = [regex]::Match($Text, "(?m)^-- " + [regex]::Escape($Key) + ":\s+(\S+)\s*$")
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value
}

# Loads vNN: the migration file, its rollback file, both hashes, the header
# fingerprints, and checks both hashes against SHA256SUMS.
function Get-FlashMigration {
    param([Parameter(Mandatory = $true)][string]$Version)
    if ($Version -notmatch '^v\d+$') { throw "Version must look like v42, got '$Version'" }
    $p = Get-FlashPaths
    $files = @(Get-ChildItem -LiteralPath $p.Migrations -File | Where-Object { $_.Name -match ('^' + $Version + '_[a-z0-9_]+\.sql$') })
    if ($files.Count -ne 1) { throw "expected exactly one $Version migration file in $($p.Migrations), found $($files.Count)" }
    $file = $files[0]
    $text = [System.IO.File]::ReadAllText($file.FullName)
    if ($text.Contains("`r")) { throw "$($file.Name) has CR line endings; the checkout is wrong (see .gitattributes)" }
    $rbName = $file.Name -replace '\.sql$', '.rollback.sql'
    $rbPath = Join-Path (Join-Path $p.Migrations 'rollback') $rbName
    if (-not (Test-Path -LiteralPath $rbPath)) { throw "rollback file $rbName not found" }
    $sums = Read-FlashChecksums
    $m = [pscustomobject]@{
        Version         = $Version
        FileName        = $file.Name
        Path            = $file.FullName
        Sha             = Get-FlashFileSha256 -Path $file.FullName
        HeaderVersion   = Get-FlashHeaderValue -Text $text -Key 'flash-migration'
        Before          = Get-FlashHeaderValue -Text $text -Key 'before-schema-sha256'
        After           = Get-FlashHeaderValue -Text $text -Key 'after-schema-sha256'
        RollbackName    = $rbName
        RollbackPath    = $rbPath
        RollbackSha     = Get-FlashFileSha256 -Path $rbPath
        SumsSha         = $sums[$file.Name]
        SumsRollbackSha = $sums['rollback/' + $rbName]
    }
    if ($m.HeaderVersion -ne $Version) { throw "header says '$($m.HeaderVersion)', expected $Version" }
    if ($m.Before -notmatch '^[0-9a-f]{64}$' -or $m.After -notmatch '^[0-9a-f]{64}$') { throw 'header fingerprints are missing or malformed' }
    if ($m.Sha -ne $m.SumsSha) { throw "$($m.FileName): sha256 $($m.Sha) does not match SHA256SUMS ($($m.SumsSha))" }
    if ($m.RollbackSha -ne $m.SumsRollbackSha) { throw "$rbName`: sha256 does not match SHA256SUMS" }
    return $m
}

function Get-FlashWorkDir {
    param([Parameter(Mandatory = $true)][string]$Version)
    # schema-baseline-input/ is git-ignored. It only ever holds SCHEMA dumps
    # (no table data); full backups go to the backups folder instead.
    $d = Join-Path (Get-FlashPaths).InputDir $Version
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}

function Assert-FlashDocker {
    $ErrorActionPreference = 'Continue'   # PS 5.1: redirected native stderr must not throw here
    & docker version --format '{{.Server.Version}}' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running. Start it and run this step again.' }
}

# Runs docker and throws on a non-zero exit. Returns stdout lines.
function Invoke-FlashDocker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $out = & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "docker exited with code $LASTEXITCODE" }
    return $out
}

# Runs ONE container to completion and returns @{ Code; Output }.
# Every runbook `docker run` goes through here. It does not use an attached
# `docker run --rm`, because Docker Desktop on Windows can leave a FINISHED
# container "running" with no process inside, and an attached `docker run`
# then never returns (seen twice in the L0.2 local proof). So: start the
# container detached, inside /p/run.sh, which prints FLASH_EXIT=<code> after
# the command; poll until it stops, or until it has had no process for 10
# seconds (the fault); read the exit code from that marker; always remove it.
# $Options: docker run options (env by NAME, mounts, network). /p (this
# folder) is mounted read-only automatically.
function Invoke-FlashContainer {
    param(
        [Parameter(Mandatory = $true)][string[]]$Options,
        [Parameter(Mandatory = $true)][string]$Image,
        [Parameter(Mandatory = $true)][string[]]$Command,
        [switch]$AllowFailure,
        [switch]$Quiet
    )
    $ErrorActionPreference = 'Continue'   # PS 5.1: native stderr must not throw inside this function
    $p = Get-FlashPaths
    $name = 'flash-step-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $runArgs = @('run', '-d', '--name', $name) + $Options + @('-v', ($p.Runbook + ':/p:ro'), $Image, 'sh', '/p/run.sh') + $Command
    $started = & docker @runArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        & docker rm -f $name *> $null
        throw ('could not start container: ' + (($started | ForEach-Object { "$_" }) -join ' '))
    }
    if (-not $Quiet) { Write-Host ('  (running ' + $Command[-1] + ' in container ' + $name + '; output appears when it finishes)') }
    $noProcess = 0
    while ($true) {
        $running = ((& docker inspect -f '{{.State.Running}}' $name 2>$null) -join '').Trim()
        if ($running -ne 'true') { break }
        $procs = @(& docker top $name 2>$null | Select-Object -Skip 1)
        if ($procs.Count -eq 0) { $noProcess++ } else { $noProcess = 0 }
        if ($noProcess -ge 10) { break }
        Start-Sleep -Seconds 1
    }
    $lines = @(& docker logs $name 2>&1 | ForEach-Object { "$_" })
    & docker rm -f $name *> $null
    $code = $null
    $output = @()
    foreach ($l in $lines) {
        if ($l -match '^FLASH_EXIT=(\d+)$') { $code = [int]$Matches[1] } else { $output += $l }
    }
    if (-not $Quiet) { $output | ForEach-Object { Write-Host ('  ' + $_) } }
    if ($null -eq $code) { throw 'the container ended without reporting an exit code; treat this step as FAILED and run it again' }
    if ($code -ne 0 -and -not $AllowFailure) { throw "container command failed with exit code $code" }
    return [pscustomobject]@{ Code = $code; Output = $output }
}

function Read-FlashProdUrl {
    Write-Host ''
    Write-Host 'Paste the production Session pooler connection string (input is hidden).'
    $secure = Read-Host -Prompt 'FLASH_PROD_DB_URL' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ($plain -notmatch '^postgres(ql)?://[^@\s]+@([^:/\s]+)(:\d+)?/\S+$') {
        $plain = $null
        throw 'That does not look like a postgresql:// connection string. Nothing was run.'
    }
    $isPooler = $Matches[2].EndsWith('.pooler.supabase.com')
    [Environment]::SetEnvironmentVariable('FLASH_PROD_DB_URL', $plain, 'Process')
    $plain = $null
    Write-Host ("Connection string read. Supabase Session pooler host: " + $(if ($isPooler) { 'yes' } else { 'NO' }))
    if (-not $isPooler) {
        Clear-FlashProdUrl
        throw 'Use the Session pooler string (host ends with .pooler.supabase.com). Nothing was run.'
    }
}

function Clear-FlashProdUrl {
    $ErrorActionPreference = 'Continue'
    # A container started with -e FLASH_PROD_DB_URL holds the value in its
    # config until it is removed. If a step was interrupted (Ctrl+C), remove
    # any leftover runbook step containers too.
    $left = @(& docker ps -a -q --filter 'name=flash-step-' 2>$null)
    foreach ($id in $left) { if ($id) { & docker rm -f $id *> $null } }
    [Environment]::SetEnvironmentVariable('FLASH_PROD_DB_URL', $null, 'Process')
    Remove-Item Env:FLASH_PROD_DB_URL -ErrorAction SilentlyContinue
    [GC]::Collect()
}

# Read-only server check (scripts/schema-baseline/prod_check.sh). Throws unless
# the server is Postgres 17 and the session is read-only.
function Invoke-FlashProdCheck {
    $p = Get-FlashPaths
    $r = Invoke-FlashContainer -Options @('-e', 'FLASH_PROD_DB_URL', '-v', ($p.SchemaTools + ':/s:ro')) -Image $script:PgImage -Command @('sh', '/s/prod_check.sh')
    $text = ($r.Output -join "`n")
    if ($text -notmatch '(?m)^server_version_num = 17\d{4}$') { throw 'server is not Postgres 17' }
    if ($text -notmatch '(?m)^session_read_only = on$') { throw 'session was not read-only' }
    return $text
}

# Read-only schema dump of production into $WorkDir\$Name.
function Invoke-FlashProdSchemaDump {
    param([Parameter(Mandatory = $true)][string]$WorkDir, [Parameter(Mandatory = $true)][string]$Name)
    $p = Get-FlashPaths
    $target = Join-Path $WorkDir $Name
    $tmp = Join-Path $WorkDir 'prod_schema_public.sql'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    Invoke-FlashContainer -Options @('-e', 'FLASH_PROD_DB_URL', '-v', ($p.SchemaTools + ':/s:ro'), '-v', ($WorkDir + ':/out')) -Image $script:PgImage -Command @('sh', '/s/prod_dump_schema.sh') | Out-Null
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    Move-Item -LiteralPath $tmp -Destination $target
    return $target
}

function Invoke-FlashLedgerRead {
    $p = Get-FlashPaths
    $r = Invoke-FlashContainer -Options @('-e', 'FLASH_PROD_DB_URL') -Image $script:PgImage -Command @('sh', '/p/ledger_read.sh')
    return @($r.Output)
}

# normalize_schema.py --baseline inside a python container with no network.
# Both files must be inside $WorkDir. Returns the fingerprint and stats.
function Get-FlashFingerprint {
    param([Parameter(Mandatory = $true)][string]$WorkDir, [Parameter(Mandatory = $true)][string]$InName, [Parameter(Mandatory = $true)][string]$OutName)
    $p = Get-FlashPaths
    $stats = (Invoke-FlashContainer -Quiet -Options @('--network', 'none', '-v', ($p.SchemaTools + ':/sb:ro'), '-v', ($WorkDir + ':/work')) -Image $script:PyImage -Command @('sh', '/p/normalize.sh', ('/work/' + $InName), ('/work/' + $OutName))).Output
    $out = Join-Path $WorkDir $OutName
    $size = (Get-Item -LiteralPath $out).Length
    $tables = @(Select-String -LiteralPath $out -Pattern '^CREATE TABLE ' -CaseSensitive).Count
    if ($size -lt 10000 -or $tables -lt 1) { throw "$OutName is (near-)empty: $size bytes, $tables tables" }
    return [pscustomobject]@{ Sha = (Get-FlashFileSha256 -Path $out); Bytes = $size; Tables = $tables; Path = $out; Stats = ($stats -join ' ') }
}

# schema_delta.py inside a python container with no network. File arguments
# are names inside $WorkDir, or 'BASELINE' for the committed baseline.
# Returns $true when the tool exits 0.
function Test-FlashSchemaDelta {
    param([Parameter(Mandatory = $true)][string]$WorkDir, [Parameter(Mandatory = $true)][string]$Mode, [Parameter(Mandatory = $true)][string[]]$Files)
    $p = Get-FlashPaths
    $paths = @($Files | ForEach-Object { if ($_ -eq 'BASELINE') { '/sb/production_schema_baseline.sql' } else { '/work/' + $_ } })
    $r = Invoke-FlashContainer -AllowFailure -Options @('--network', 'none', '-v', ($p.SchemaTools + ':/sb:ro'), '-v', ($WorkDir + ':/work:ro')) -Image $script:PyImage -Command (@('python', '-I', '/p/schema_delta.py', $Mode) + $paths)
    return ($r.Code -eq 0)
}

# A file name that never overwrites an earlier run: <Base>_<yyyyMMdd_HHmmss>.<Extension>
# in local time (the founder's clock). Used for evidence files such as the
# readiness output, so every run is kept.
function Get-FlashStampedFileName {
    param(
        [Parameter(Mandatory = $true)][string]$Base,
        [string]$Extension = 'txt',
        [DateTime]$Now = (Get-Date)
    )
    if ($Base -notmatch '^[A-Za-z0-9_-]+$') { throw "Base must be letters, digits, '_' or '-' (got '$Base')" }
    if ($Extension -notmatch '^[A-Za-z0-9]+$') { throw "Extension must be letters or digits (got '$Extension')" }
    return ($Base + '_' + $Now.ToString('yyyyMMdd_HHmmss', [Globalization.CultureInfo]::InvariantCulture) + '.' + $Extension)
}

# v43 post-check (FI-081, #73): judges rls_readiness.sh output lines. PASS
# only if: every table has RLS (rls_enabled = tables = ExpectedTables);
# no table grants anon/authenticated; no sequence or function in public is
# granted to them; postgres's default ACLs no longer mention them; and the
# readiness verdict is OK (the backend role keeps access). Pure function: it
# never connects to anything, so it is unit-tested in CI.
function Test-FlashV43Lockdown {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Lines, [int]$ExpectedTables = 67)
    $failures = New-Object System.Collections.Generic.List[string]
    $summary = @($Lines | Where-Object { $_ -like 'summary|*' })
    if ($summary.Count -ne 1) {
        $failures.Add('no summary line in the readiness output')
    } else {
        $kv = @{}
        foreach ($part in ($summary[0] -split '\|' | Select-Object -Skip 1)) {
            $i = $part.IndexOf('=')
            if ($i -gt 0) { $kv[$part.Substring(0, $i)] = $part.Substring($i + 1) }
        }
        if ($kv['tables'] -ne [string]$ExpectedTables) { $failures.Add("tables=$($kv['tables']), expected $ExpectedTables") }
        if ($kv['rls_enabled'] -ne [string]$ExpectedTables) { $failures.Add("rls_enabled=$($kv['rls_enabled']), expected $ExpectedTables") }
        if ($kv['tables_with_anon_or_auth_privs'] -ne '0') { $failures.Add("tables_with_anon_or_auth_privs=$($kv['tables_with_anon_or_auth_privs']), expected 0") }
    }
    foreach ($l in @($Lines | Where-Object { $_ -like 'sequence|*' })) {
        $f = $l -split '\|'
        if ($f[3] -ne '0' -or $f[4] -ne '0') { $failures.Add("sequence $($f[1]) still granted to anon/authenticated") }
    }
    foreach ($l in @($Lines | Where-Object { $_ -like 'function|*' })) {
        $f = $l -split '\|'
        if ($f[3] -ne 'f' -or $f[4] -ne 'f') { $failures.Add("function $($f[1]) still executable by anon/authenticated") }
    }
    foreach ($l in @($Lines | Where-Object { $_ -like 'default_acl|postgres|*' })) {
        $f = $l -split '\|'
        if ($f[4] -match '(^|[{,])"?(anon|authenticated)"?=') { $failures.Add("postgres default privileges for $($f[2]) in $($f[3]) still mention anon/authenticated") }
    }
    $verdict = @($Lines | Where-Object { $_ -like 'verdict|*' })
    if ($verdict.Count -ne 1 -or $verdict[0] -notlike 'verdict|OK*') { $failures.Add('readiness verdict is not OK (the backend role would not keep access to every table)') }
    return [pscustomobject]@{ Pass = ($failures.Count -eq 0); Failures = $failures.ToArray() }
}

# Throwaway local postgres:17 with NO network: it cannot reach production or
# anything else. Data lives in tmpfs and disappears with the container.
function Start-FlashLocalPg {
    param([string[]]$Mounts = @())
    $name = 'flash-runbook-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $pw = [guid]::NewGuid().ToString('N')
    $dockerArgs = @('run', '-d', '--rm', '--name', $name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', ('POSTGRES_PASSWORD=' + $pw))
    foreach ($m in $Mounts) { $dockerArgs += @('-v', $m) }
    $dockerArgs += $script:PgImage
    Invoke-FlashDocker $dockerArgs | Out-Null
    $ErrorActionPreference = 'Continue'   # PS 5.1: redirected native stderr must not throw while polling
    for ($i = 0; $i -lt 60; $i++) {
        & docker exec $name pg_isready -U postgres -q *> $null
        if ($LASTEXITCODE -eq 0) {
            & docker exec $name psql -U postgres -At -c 'SELECT 1' *> $null
            if ($LASTEXITCODE -eq 0) { return $name }
        }
        Start-Sleep -Seconds 1
    }
    & docker rm -f $name *> $null
    throw 'local postgres did not become ready'
}

function Stop-FlashLocalPg {
    param([string]$Name)
    $ErrorActionPreference = 'Continue'
    if ($Name) { & docker rm -f $Name *> $null }
}

function Confirm-FlashTyped {
    param([Parameter(Mandatory = $true)][string]$Expected, [Parameter(Mandatory = $true)][string]$Prompt)
    $answer = Read-Host -Prompt ($Prompt + " (type exactly: " + $Expected + ")")
    if ($answer -cne $Expected) { throw "Not confirmed (you typed '$answer'). Nothing was done." }
}

function Write-FlashStep {
    param([string]$Text)
    Write-Host ''
    Write-Host ('== ' + $Text)
}

function Write-FlashCheck {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [" + $tag + "] " + $Name + $(if ($Detail) { ': ' + $Detail } else { '' }))
    if (-not $Ok) { throw ("check failed: " + $Name) }
}

function Get-FlashSastNow {
    $tz = [TimeZoneInfo]::FindSystemTimeZoneById('South Africa Standard Time')
    return [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
}

function Write-FlashMarker {
    param([string]$Path, [hashtable]$Data)
    $Data['written_utc'] = [DateTime]::UtcNow.ToString('o')
    $lines = $Data.Keys | Sort-Object | ForEach-Object { $_ + '=' + $Data[$_] }
    [System.IO.File]::WriteAllLines($Path, [string[]]$lines)
}

function Read-FlashMarker {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $h = @{}
    foreach ($l in [System.IO.File]::ReadAllLines($Path)) {
        $i = $l.IndexOf('=')
        if ($i -gt 0) { $h[$l.Substring(0, $i)] = $l.Substring($i + 1) }
    }
    return $h
}

function Get-FlashMarkerAgeHours {
    param([hashtable]$Marker)
    $t = [DateTime]::Parse($Marker['written_utc'], $null, [Globalization.DateTimeStyles]::RoundtripKind)
    return ([DateTime]::UtcNow - $t.ToUniversalTime()).TotalHours
}

Export-ModuleMember -Function *-Flash*
