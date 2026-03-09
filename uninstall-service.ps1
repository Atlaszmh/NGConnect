#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Remove NGConnect startup task.
#>

$TaskName = "NGConnect Server"

Write-Host ""
Write-Host "  Uninstalling NGConnect service..." -ForegroundColor Cyan

# Stop the task if running
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName
        Write-Host "  Stopped running task." -ForegroundColor Yellow
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  [OK] Task '$TaskName' removed." -ForegroundColor Green
} else {
    Write-Host "  [INFO] Task '$TaskName' not found. Nothing to remove." -ForegroundColor Yellow
}

# Also kill any lingering process on port 3001
$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "  Stopped process on port 3001." -ForegroundColor Yellow
}

Write-Host ""
