#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install the "NGConnect Updater" Scheduled Task (boot + hourly) on the server PC.
.DESCRIPTION
    Idempotent. Verifies prerequisites, ensures NODE_ENV=production is set so the
    dashboard client is served, registers the updater task, and confirms the
    "NGConnect Server" task exists.
#>
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$UpdatePs1  = Join-Path $PSScriptRoot 'update.ps1'
$EnvFile    = Join-Path $RepoRoot '.env'
$TaskName   = 'NGConnect Updater'
$ServerTask = 'NGConnect Server'

Write-Host ''
Write-Host '  Installing NGConnect Updater...' -ForegroundColor Cyan

# 1. Prerequisites
foreach ($tool in 'git', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "  [ERROR] '$tool' not found on PATH." -ForegroundColor Red; exit 1
    }
}
Push-Location $RepoRoot
try { & git rev-parse --is-inside-work-tree | Out-Null } catch {
    Write-Host '  [ERROR] Repo root is not a git working tree.' -ForegroundColor Red; Pop-Location; exit 1
}
Pop-Location
if (-not (Test-Path $UpdatePs1)) {
    Write-Host "  [ERROR] update.ps1 not found at $UpdatePs1" -ForegroundColor Red; exit 1
}

# 2. Ensure NODE_ENV=production is present in .env (so static client is served)
if (Test-Path $EnvFile) {
    $envText = Get-Content $EnvFile -Raw
    if ($envText -notmatch '(?m)^\s*NODE_ENV\s*=') {
        Add-Content -Path $EnvFile -Value 'NODE_ENV=production'
        Write-Host '  [OK] Added NODE_ENV=production to .env' -ForegroundColor Green
    }
} else {
    Set-Content -Path $EnvFile -Value 'NODE_ENV=production'
    Write-Host '  [WARN] .env did not exist; created it with NODE_ENV=production only.' -ForegroundColor Yellow
    Write-Host '         Add your service URLs/API keys to .env.' -ForegroundColor Yellow
}

# 3. Register the updater task (replace if present)
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
# update.ps1 derives all its paths from $PSScriptRoot and does its own
# Set-Location, so -WorkingDirectory here is not load-bearing (set for tidiness).
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdatePs1`"" `
    -WorkingDirectory $RepoRoot
$atBoot = New-ScheduledTaskTrigger -AtStartup
# Omit -RepetitionDuration => repeat indefinitely. Do NOT use [TimeSpan]::MaxValue:
# some Windows builds reject or silently coerce it, dropping the hourly repeat.
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($atBoot, $hourly) -Settings $settings -Principal $principal `
    -Description 'Polls origin/main and self-deploys NGConnect (boot + hourly).' | Out-Null

# Read back and confirm the hourly repetition actually registered (guards against
# a Windows build coercing/dropping it, which would silently break "hourly").
$reg = Get-ScheduledTask -TaskName $TaskName
$interval = ($reg.Triggers | Where-Object { $_.Repetition.Interval } | Select-Object -First 1).Repetition.Interval
if ($interval -eq 'PT1H') {
    Write-Host "  [OK] Registered '$TaskName' (at boot + every hour; repetition PT1H confirmed)." -ForegroundColor Green
} else {
    Write-Host "  [WARN] Registered '$TaskName', but the hourly repetition read back as '$interval' (expected PT1H)." -ForegroundColor Yellow
    Write-Host '         The boot trigger still works; re-run this installer or add the hourly trigger by hand.' -ForegroundColor Yellow
}

# 4. Confirm the server task exists
if (-not (Get-ScheduledTask -TaskName $ServerTask -ErrorAction SilentlyContinue)) {
    Write-Host "  [WARN] '$ServerTask' task not found. Run install-service.ps1 first." -ForegroundColor Yellow
}

Write-Host ''
$run = Read-Host '  Run an update check now? (Y/n)'
if ($run -ne 'n' -and $run -ne 'N') { Start-ScheduledTask -TaskName $TaskName }
Write-Host '  Done.' -ForegroundColor Green
