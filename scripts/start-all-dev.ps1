param(
  [switch]$UseMockBackend,
  [switch]$DryRun,
  [int]$UserPort = 8081,
  [int]$DriverPort = 8084,
  [string]$ApiBaseUrl
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$backendPath = Join-Path $projectRoot "backend"
$userAppPath = Join-Path $projectRoot "flash-user-app"
$driverAppPath = Join-Path $projectRoot "flash-driver-app"

function Get-LanIp {
  try {
    $defaultRoute = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -AddressFamily IPv4 |
    Sort-Object RouteMetric |
    Select-Object -First 1

    if ($defaultRoute) {
      $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $defaultRoute.InterfaceIndex |
      Where-Object {
        $_.IPAddress -notlike "169.254.*" -and
        $_.IPAddress -ne "127.0.0.1"
      } |
      Select-Object -First 1 -ExpandProperty IPAddress

      if ($ip) { return $ip }
    }
  }
  catch {
    # Fallback below.
  }

  return "127.0.0.1"
}

if (-not $ApiBaseUrl) {
  $ApiBaseUrl = "http://$(Get-LanIp):3000"
}

Write-Host "Using API base URL: $ApiBaseUrl"

# Free common Expo ports before startup to avoid interactive prompts.
$expoPorts = @($UserPort, $DriverPort, 8082, 8083)
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
Where-Object { $expoPorts -contains $_.LocalPort } |
Select-Object -ExpandProperty OwningProcess -Unique

if ($pids) {
  Write-Host "Stopping existing processes on Expo ports: $($pids -join ', ')"
  if (-not $DryRun) {
    Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue
  }
}

if ($UseMockBackend) {
  $backendCommand = "Set-Location -LiteralPath '$backendPath'; docker compose stop backend; node .\mock-server.js"
}
else {
  $backendCommand = "Set-Location -LiteralPath '$projectRoot'; docker compose up -d; docker compose ps"
}

$userCommand = "Set-Location -LiteralPath '$userAppPath'; `$env:EXPO_PUBLIC_API_BASE_URL='$ApiBaseUrl'; npx expo start --clear --port $UserPort"
$driverCommand = "Set-Location -LiteralPath '$driverAppPath'; `$env:EXPO_PUBLIC_API_BASE_URL='$ApiBaseUrl'; npx expo start --clear --port $DriverPort"

Write-Host ""
Write-Host "Backend command:"
Write-Host $backendCommand
Write-Host ""
Write-Host "User app command:"
Write-Host $userCommand
Write-Host ""
Write-Host "Driver app command:"
Write-Host $driverCommand
Write-Host ""

if ($DryRun) {
  Write-Host "Dry run complete. No terminals were started."
  exit 0
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand | Out-Null
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", $userCommand | Out-Null
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList "-NoExit", "-Command", $driverCommand | Out-Null

Write-Host "Started backend + user app + driver app in separate PowerShell windows."