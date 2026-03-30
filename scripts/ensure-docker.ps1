param(
  [switch]$RunMigrations,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Test-DockerDaemon {
  & docker version --format '{{.Server.Version}}' 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is not installed or not on PATH."
}

if (-not (Test-Path $dockerDesktopPath)) {
  throw "Docker Desktop was not found at '$dockerDesktopPath'."
}

if (-not (Test-DockerDaemon)) {
  Write-Host "Starting Docker Desktop..."
  Start-Process $dockerDesktopPath | Out-Null

  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-DockerDaemon) {
      break
    }
  }
}

if (-not (Test-DockerDaemon)) {
  throw "Docker daemon did not become ready within 3 minutes."
}

Push-Location $projectRoot
try {
  $composeArgs = @("compose", "up", "-d", "--remove-orphans")
  if (-not $SkipBuild) {
    $composeArgs += "--build"
  }

  & docker @composeArgs
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose up failed."
  }

  if ($RunMigrations) {
    & docker compose exec backend npm run migrate
    if ($LASTEXITCODE -ne 0) {
      throw "Database migration failed."
    }
  }

  & docker compose ps
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose ps failed."
  }
}
finally {
  Pop-Location
}