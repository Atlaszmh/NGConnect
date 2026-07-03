<#
.SYNOPSIS
    NGConnect auto-deploy updater. Fetches origin/main and, if changed,
    tests + builds + restarts the "NGConnect Server" Scheduled Task.
.DESCRIPTION
    Run by the "NGConnect Updater" Scheduled Task at boot and hourly, and on
    demand when the dashboard "Check for Updates Now" button triggers that task.
    Safe by construction: success is recorded only after a healthy restart, so
    any failure leaves the last-good build running and is retried next run.
.PARAMETER DryRun
    For testing on the dev PC. Runs fetch -> npm ci -> test -> build against the
    CURRENT working tree, but SKIPS the destructive 'git reset --hard', the
    service restart, the health check, and writing .last-deployed. Still writes
    .deploy-status.json so the run is observable.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$RepoRoot      = Split-Path -Parent $PSScriptRoot   # deploy/ -> repo root
$DeployDir     = $PSScriptRoot
$LogDir        = Join-Path $DeployDir 'logs'
$LogFile       = Join-Path $LogDir 'update.log'
$StatusFile    = Join-Path $DeployDir '.deploy-status.json'
$LastDeployed  = Join-Path $DeployDir '.last-deployed'
$LockFile      = Join-Path $DeployDir '.update.lock'
$ServerTask    = 'NGConnect Server'
$HealthUrl     = 'http://localhost:3001/healthz'
$MaxLogBytes   = 200KB

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line
    Write-Host $line
}

function Limit-Log {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
        $keep = Get-Content $LogFile -Tail 2000
        Set-Content -Path $LogFile -Value $keep
    }
}

function Write-Utf8NoBom([string]$path, [string]$content) {
    # Node's fs.readFileSync(..,'utf-8') + JSON.parse do NOT tolerate a BOM, and
    # Set-Content -Encoding utf8 writes one on Windows PowerShell 5.1 — which
    # would make the dashboard's status read always fall back to the default.
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Write-Status([string]$result, [string]$sha, [string]$subject, [string]$err) {
    $obj = [ordered]@{
        sha       = $sha
        subject   = $subject
        lastCheck = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        result    = $result
        error     = $err
    }
    Write-Utf8NoBom $StatusFile ($obj | ConvertTo-Json -Compress)
}

# NB: the parameter must NOT be named $args — that is a PowerShell automatic
# variable, so a param called $args never receives the caller's array and the
# command would run with no arguments.
function Run([string]$exe, [string[]]$argList, [string]$cwd) {
    Push-Location $cwd
    try {
        & $exe @argList
        if ($LASTEXITCODE -ne 0) { throw "$exe $($argList -join ' ') exited $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

Limit-Log

# 1. Single-instance guard
$lock = $null
try {
    $lock = [System.IO.File]::Open($LockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    Write-Log 'Another update run is in progress; exiting.'
    exit 0
}

try {
    Set-Location $RepoRoot

    # 2. Fetch and compare
    Write-Log 'Fetching origin/main...'
    Run 'git' @('fetch', '--quiet', 'origin', 'main') $RepoRoot
    $remote = (& git rev-parse --short origin/main).Trim()
    $current = if (Test-Path $LastDeployed) { (Get-Content $LastDeployed -Raw).Trim() } else { '' }

    if ($remote -eq $current -and -not $DryRun) {
        Write-Log "Up to date at $remote."
        Write-Status 'up-to-date' $remote (& git log -1 --format='%s' origin/main).Trim() $null
        exit 0
    }
    if ($remote -eq $current) {
        Write-Log "DryRun: building current tree at $remote (already up to date)."
    } else {
        Write-Log "Update: $current -> $remote"
    }

    # 3. Which lockfiles changed? (empty base on first run => treat all as changed)
    $changed = @()
    if ($current) {
        $changed = & git diff --name-only $current origin/main -- `
            package-lock.json server/package-lock.json client/package-lock.json
    }
    $firstRun = [string]::IsNullOrWhiteSpace($current)

    # 4. Update working tree to the target. Skipped under -DryRun so the script
    #    is safe to run on a dev checkout without discarding local/unpushed work.
    if (-not $DryRun) {
        Write-Log 'Resetting working tree to origin/main...'
        Run 'git' @('reset', '--hard', 'origin/main') $RepoRoot
    } else {
        Write-Log 'DryRun: skipping git reset --hard (building the current tree).'
    }

    # 5. Install deps (only changed packages; all three on first run)
    function Should-Install($lockPath) {
        if ($firstRun) { return $true }
        return ($changed | Where-Object { $_ -eq $lockPath }).Count -gt 0
    }
    if (Should-Install 'package-lock.json')        { Write-Log 'npm ci (root)';   Run 'npm' @('ci') $RepoRoot }
    if (Should-Install 'server/package-lock.json') { Write-Log 'npm ci (server)'; Run 'npm' @('ci') (Join-Path $RepoRoot 'server') }
    if (Should-Install 'client/package-lock.json') { Write-Log 'npm ci (client)'; Run 'npm' @('ci') (Join-Path $RepoRoot 'client') }

    # 6. Test BEFORE building (a bad commit aborts before dist/ is overwritten)
    Write-Log 'Running server tests...'
    Run 'npm' @('test') (Join-Path $RepoRoot 'server')

    # 7. Build
    Write-Log 'Building client + server...'
    Run 'npm' @('run', 'build') $RepoRoot

    if ($DryRun) {
        Write-Log 'DryRun: skipping restart, health check, and .last-deployed write.'
        Write-Status 'updated' $remote (& git log -1 --format='%s' origin/main).Trim() $null
        exit 0
    }

    # 8. Restart the server task, waiting for the port to free first
    Write-Log 'Restarting NGConnect Server task...'
    Stop-ScheduledTask -TaskName $ServerTask -ErrorAction SilentlyContinue
    $freed = $false
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        if (-not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) { $freed = $true; break }
    }
    if (-not $freed) {
        Write-Log 'Port 3001 still held; force-stopping the listening process.'
        $conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Start-ScheduledTask -TaskName $ServerTask

    # 9. Health check: GET /healthz == 200, up to ~60s
    Write-Log 'Waiting for server to become healthy...'
    $healthy = $false
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 3
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
            if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) {
        Write-Log 'ERROR: health check timed out.'
        # Record $remote (the SHA we just deployed and restarted into), not the
        # old $current — the working tree is already at $remote by this point.
        Write-Status 'failed' $remote (& git log -1 --format='%s' origin/main).Trim() 'health check timed out'
        exit 1
    }

    # 10. Record success LAST
    $subject = (& git log -1 --format='%s' origin/main).Trim()
    Write-Utf8NoBom $LastDeployed $remote
    Write-Status 'updated' $remote $subject $null
    Write-Log "Deployed $remote successfully."
    exit 0
}
catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    try {
        $sha = (& git rev-parse --short origin/main 2>$null)
        Write-Status 'failed' ($sha) $null $_.Exception.Message
    } catch { }
    exit 1
}
finally {
    if ($lock) { $lock.Close() }
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
