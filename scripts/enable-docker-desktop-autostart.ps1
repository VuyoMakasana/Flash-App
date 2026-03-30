param(
  [switch]$Disable
)

$ErrorActionPreference = "Stop"

$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$valueName = "DockerDesktop"

if (-not (Test-Path $dockerDesktopPath)) {
  throw "Docker Desktop was not found at '$dockerDesktopPath'."
}

if ($Disable) {
  Remove-ItemProperty -Path $runKey -Name $valueName -ErrorAction SilentlyContinue
  Write-Host "Docker Desktop auto-start disabled for this Windows user."
  exit 0
}

New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name $valueName -Value ('"{0}"' -f $dockerDesktopPath)

Write-Host "Docker Desktop will now launch automatically when this Windows user signs in."