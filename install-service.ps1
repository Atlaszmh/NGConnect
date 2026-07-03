#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install NGConnect as a Windows startup task.
.DESCRIPTION
    Creates a Scheduled Task that starts NGConnect at system boot,
    runs in the background, and auto-restarts on failure.
    Must be run as Administrator.
#>

$ErrorActionPreference = "Stop"
$TaskName = "NGConnect Server"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
$ServerScript = Join-Path $ProjectDir "server\dist\index.js"
$EnvFile = Join-Path $ProjectDir ".env"

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host "    NGConnect - Install as Windows Service" -ForegroundColor Cyan
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host ""

# Validate
if (-not $NodePath) {
    Write-Host "  [ERROR] Node.js not found in PATH." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $ServerScript)) {
    Write-Host "  [INFO] Server not built yet. Building..." -ForegroundColor Yellow
    Push-Location $ProjectDir
    npm run build
    Pop-Location
    if (-not (Test-Path $ServerScript)) {
        Write-Host "  [ERROR] Build failed." -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path $EnvFile)) {
    Write-Host "  [WARNING] No .env file found. Server may not work correctly." -ForegroundColor Yellow
}

# Ensure NODE_ENV=production so the server serves the built client (index.ts
# gates static serving on NODE_ENV). The task loads .env via --env-file.
# Note: only appends when .env already exists. Creating .env when absent is
# intentionally left to install-updater.ps1 (this installer only warns), so the
# two scripts don't both try to author a fresh .env.
if (Test-Path $EnvFile) {
    $envText = Get-Content $EnvFile -Raw
    if ($envText -notmatch '(?m)^\s*NODE_ENV\s*=') {
        Add-Content -Path $EnvFile -Value 'NODE_ENV=production'
        Write-Host '  [OK] Added NODE_ENV=production to .env' -ForegroundColor Green
    }
}

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Removing existing task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create the task
$action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "--env-file=`"$EnvFile`" `"$ServerScript`"" `
    -WorkingDirectory (Join-Path $ProjectDir "server")

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Set environment variable for production
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "NGConnect media server dashboard - runs on port 3001" | Out-Null

Write-Host ""
Write-Host "  [OK] NGConnect installed as startup task." -ForegroundColor Green
Write-Host ""
Write-Host "  Task Name:  $TaskName" -ForegroundColor White
Write-Host "  Node:       $NodePath" -ForegroundColor White
Write-Host "  Server:     $ServerScript" -ForegroundColor White
Write-Host "  URL:        http://localhost:3001" -ForegroundColor White
Write-Host ""
Write-Host "  The server will start automatically at boot." -ForegroundColor White
Write-Host "  To start it now, run:" -ForegroundColor White
Write-Host "    Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
Write-Host ""

# Offer to start now
$start = Read-Host "  Start the server now? (Y/n)"
if ($start -ne "n" -and $start -ne "N") {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    if ($info.LastTaskResult -eq 267009 -or (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host "  [OK] Server is running at http://localhost:3001" -ForegroundColor Green
    } else {
        Write-Host "  [INFO] Server starting... check http://localhost:3001 in a moment." -ForegroundColor Yellow
    }
}

Write-Host ""
