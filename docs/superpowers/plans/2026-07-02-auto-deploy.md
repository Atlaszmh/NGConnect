# NGConnect Auto-Deploy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the server PC self-update from `origin/main` (at boot + hourly, plus an on-demand dashboard button), safely testing and building each change before restarting, so a broken commit never takes the running server down.

**Architecture:** A version-controlled PowerShell updater (`deploy/update.ps1`) run by a "NGConnect Updater" Scheduled Task fetches `origin/main`, and on change: `reset --hard` → selective `npm ci` → **test → build → restart → health-check `/healthz`** → record success only at the end. The dashboard gains an always-on unauthenticated `/healthz` liveness route, two authed `/api/system/update/*` routes (status + on-demand trigger), and an "Updates" card in Settings. The web process never runs git/build logic itself — the button just triggers the same Scheduled Task, so scheduled and on-demand deploys are identical.

**Tech Stack:** Node 20+/Express 5 + TypeScript (server), React + Vite + TypeScript (client), vitest (server tests, pure-function style), PowerShell + Windows Scheduled Tasks (deploy), git.

**Spec:** [docs/superpowers/specs/2026-07-02-auto-deploy-design.md](../specs/2026-07-02-auto-deploy-design.md)

---

## File Structure

**New files:**
- `server/src/services/deploy.ts` — deploy-status reading + updater-trigger classification (pure logic + thin side-effecting wrapper). One responsibility: everything the web process needs to know about deploys.
- `server/src/services/deploy.test.ts` — vitest unit tests for the pure functions in `deploy.ts`.
- `server/src/routes/health.ts` — the always-on unauthenticated `healthRouter` exposing `GET /healthz`.
- `deploy/update.ps1` — the updater pipeline (boot/hourly/on-demand).
- `deploy/install-updater.ps1` — one-time admin setup on the server PC.
- `deploy/README.md` — short operator notes (how it works, where logs live, how to check status).

**Modified files:**
- `server/src/index.ts` — mount `healthRouter` before auth and the `NODE_ENV` static block.
- `server/src/routes/system.ts` — add `GET /update/status` and `POST /update/check`.
- `client/src/pages/SettingsPage.tsx` — add the "Updates" card; show the real running commit.
- `install-service.ps1` — fix the latent `NODE_ENV=production` gap.
- `.gitignore` — ignore the updater's runtime state files.

**Runtime state (gitignored, created at runtime, never committed):**
- `deploy/.deploy-status.json` — status surfaced to the dashboard.
- `deploy/.last-deployed` — last successfully deployed SHA.
- `deploy/.update.lock` — single-instance lock.
- `deploy/logs/update.log` — append-only log (already covered by `*.log`).

---

## Chunk 1: Server — health route, deploy service, update routes, gitignore

### Task 1: Ignore updater runtime state

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add ignore rules**

Append these lines to `.gitignore` (the `deploy/logs/*.log` case is already covered by the existing `*.log`, but the state files need explicit rules):

```gitignore
# Auto-deploy updater runtime state
deploy/.deploy-status.json
deploy/.last-deployed
deploy/.update.lock
```

- [ ] **Step 2: Verify nothing is already tracked**

Run: `git status --short deploy/`
Expected: no output (the `deploy/` folder's runtime files do not exist yet and are ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore auto-deploy updater runtime state"
```

---

### Task 2: Deploy-status reader (pure function, TDD)

The web process reads `deploy/.deploy-status.json` to show update status. All meaningful logic (parse, default on missing/corrupt) lives in a pure function tested directly — matching the repo's existing `parseVpnStatus` test style.

**Files:**
- Create: `server/src/services/deploy.ts`
- Test: `server/src/services/deploy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/deploy.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDeployStatus, DEFAULT_DEPLOY_STATUS } from './deploy';

const tmpFiles: string[] = [];
function tmpFile(contents: string): string {
  const p = path.join(os.tmpdir(), `deploy-status-${tmpFiles.length}-${process.pid}.json`);
  fs.writeFileSync(p, contents, 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('readDeployStatus', () => {
  it('returns the default (result "unknown") when the file is missing', () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${process.pid}.json`);
    expect(readDeployStatus(missing)).toEqual(DEFAULT_DEPLOY_STATUS);
  });

  it('returns the default when the file is corrupt JSON', () => {
    const p = tmpFile('{ not valid json ');
    expect(readDeployStatus(p)).toEqual(DEFAULT_DEPLOY_STATUS);
  });

  it('parses a valid status file', () => {
    const status = {
      sha: '49c5c42',
      subject: 'Update VPN monitor and add vitest for testing',
      lastCheck: '2026-07-02T14:05:00Z',
      result: 'up-to-date',
      error: null,
    };
    const p = tmpFile(JSON.stringify(status));
    expect(readDeployStatus(p)).toEqual(status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/deploy.test.ts`
Expected: FAIL — cannot resolve `./deploy` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/deploy.ts`:

```ts
import fs from 'fs';
import path from 'path';

export interface DeployStatus {
  sha: string | null;
  subject: string | null;
  lastCheck: string | null;
  result: 'up-to-date' | 'updated' | 'failed' | 'unknown';
  error: string | null;
}

export const DEFAULT_DEPLOY_STATUS: DeployStatus = {
  sha: null,
  subject: null,
  lastCheck: null,
  result: 'unknown',
  error: null,
};

// Repo-root deploy/.deploy-status.json, resolved from this file's location.
// At runtime (server/dist/services) and under vitest/tsx (server/src/services),
// three levels up is the repo root in both cases.
export const DEPLOY_STATUS_PATH = path.resolve(
  __dirname,
  '../../../deploy/.deploy-status.json'
);

/**
 * Read and parse the updater's status file. Never throws: any problem
 * (missing file, unreadable, corrupt JSON) yields DEFAULT_DEPLOY_STATUS.
 */
export function readDeployStatus(filePath: string): DeployStatus {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DeployStatus>;
    return { ...DEFAULT_DEPLOY_STATUS, ...parsed };
  } catch {
    return DEFAULT_DEPLOY_STATUS;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/deploy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/deploy.ts server/src/services/deploy.test.ts
git commit -m "feat(server): add deploy-status reader with defaults"
```

---

### Task 3: Updater-trigger classification (pure function, TDD)

`POST /api/system/update/check` shells out to `schtasks /run /tn "NGConnect Updater"`. The only non-trivial logic is classifying the result — especially detecting "task not installed" so the UI can show a clear message. That classification is a pure function, tested directly; the actual spawn is a thin wrapper.

**Files:**
- Modify: `server/src/services/deploy.ts`
- Modify: `server/src/services/deploy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/deploy.test.ts`:

```ts
import { classifyTriggerResult } from './deploy';

describe('classifyTriggerResult', () => {
  it('reports triggered when there is no error', () => {
    expect(classifyTriggerResult(null, '')).toEqual({ triggered: true });
  });

  it('reports updater-not-installed when schtasks cannot find the task', () => {
    const stderr = 'ERROR: The system cannot find the file specified.';
    const err = new Error('Command failed');
    expect(classifyTriggerResult(err, stderr)).toEqual({
      triggered: false,
      reason: 'updater-not-installed',
    });
  });

  it('reports updater-not-installed on the "does not exist" phrasing', () => {
    const stderr = 'ERROR: The specified task name "NGConnect Updater" does not exist in the system.';
    const err = new Error('Command failed');
    expect(classifyTriggerResult(err, stderr)).toEqual({
      triggered: false,
      reason: 'updater-not-installed',
    });
  });

  it('reports a generic error for any other failure', () => {
    const stderr = 'ERROR: Access is denied.';
    const err = new Error('Command failed');
    const result = classifyTriggerResult(err, stderr);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/deploy.test.ts`
Expected: FAIL — `classifyTriggerResult` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `server/src/services/deploy.ts`:

```ts
import { execFile } from 'child_process';

export interface TriggerResult {
  triggered: boolean;
  reason?: 'updater-not-installed' | 'error';
  detail?: string;
}

const TASK_NAME = 'NGConnect Updater';

/**
 * Classify the outcome of the schtasks invocation. Pure — no side effects.
 * `error` is the execFile error (null on success); `stderr` is its stderr.
 */
export function classifyTriggerResult(
  error: Error | null,
  stderr: string
): TriggerResult {
  if (!error) return { triggered: true };
  const text = (stderr || error.message || '').toLowerCase();
  if (text.includes('cannot find the file') || text.includes('does not exist')) {
    return { triggered: false, reason: 'updater-not-installed' };
  }
  return { triggered: false, reason: 'error', detail: stderr || error.message };
}

/**
 * Fire-and-return: start the "NGConnect Updater" Scheduled Task. Resolves once
 * schtasks returns (which is immediate — it only *starts* the task). Never
 * rejects; failures are reported via the returned TriggerResult.
 */
export function triggerUpdateCheck(): Promise<TriggerResult> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      ['/run', '/tn', TASK_NAME],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        resolve(classifyTriggerResult(error, stderr ?? ''));
      }
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/deploy.test.ts`
Expected: PASS (7 tests total in the file).

- [ ] **Step 5: Run the full server suite to confirm no regressions**

Run: `cd server && npm test`
Expected: PASS — existing vpnMonitor tests plus the new deploy tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/deploy.ts server/src/services/deploy.test.ts
git commit -m "feat(server): add updater-trigger with not-installed classification"
```

---

### Task 4: Always-on `/healthz` liveness route

The updater's health gate needs an endpoint that returns 200 regardless of `NODE_ENV` and without auth. Put it in its own router mounted at the app root before auth.

**Files:**
- Create: `server/src/routes/health.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create the health router**

Create `server/src/routes/health.ts`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';

export const healthRouter = Router();

// Unauthenticated, always-on liveness probe used by the auto-deploy updater.
// Must not depend on NODE_ENV or any downstream service.
healthRouter.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});
```

- [ ] **Step 2: Mount it before auth and the static block**

In `server/src/index.ts`, add the import alongside the other route imports (near line 11):

```ts
import { healthRouter } from './routes/health';
```

Then mount it immediately after `app.use(requestLogger);` (line 27) and **before** the `/api/auth` line — so it sits ahead of every auth-protected route and the `NODE_ENV` static block:

```ts
// Liveness probe for the auto-deploy updater (public, always mounted)
app.use(healthRouter);
```

- [ ] **Step 3: Build the server to confirm it compiles**

Run: `cd server && npm run build`
Expected: `tsc` completes with no errors; `server/dist/routes/health.js` exists.

- [ ] **Step 4: Manually verify the route returns 200 without auth**

Run (two commands):
```bash
cd server && cross-env NODE_ENV=development node --env-file=../.env dist/index.js &
sleep 3 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/healthz
```
Expected: `200` (note: `NODE_ENV=development`, proving the route is independent of the production static block). Stop the server afterward (`kill %1` or Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/health.ts server/src/index.ts
git commit -m "feat(server): add always-on unauthenticated /healthz route"
```

---

### Task 5: `/api/system/update/status` and `/api/system/update/check` routes

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add imports and routes**

In `server/src/routes/system.ts`, add to the imports at the top:

```ts
import {
  readDeployStatus,
  triggerUpdateCheck,
  DEPLOY_STATUS_PATH,
} from '../services/deploy';
```

Add these two routes to `systemRouter` (e.g. after the `/health/services` route at the end of the file):

```ts
// Current auto-deploy status (read from the updater's status file)
systemRouter.get('/update/status', (_req: Request, res: Response) => {
  res.json(readDeployStatus(DEPLOY_STATUS_PATH));
});

// Trigger an on-demand update check by starting the updater Scheduled Task.
// Fire-and-return: does not run any git/build logic in this process.
systemRouter.post('/update/check', async (_req: Request, res: Response) => {
  const result = await triggerUpdateCheck();
  if (result.triggered) {
    res.json({ triggered: true });
  } else if (result.reason === 'updater-not-installed') {
    res.status(409).json({ triggered: false, reason: 'updater-not-installed' });
  } else {
    res.status(500).json({ triggered: false, reason: 'error', detail: result.detail });
  }
});
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `cd server && npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 3: Manually verify status endpoint shape**

With the server running (dev mode is fine) and authenticated, `GET /api/system/update/status` returns the default `{ "result": "unknown", ... }` when no status file exists yet. (Full auth flow is exercised in the Chunk 4 end-to-end task; here just confirm the server starts and the route is registered without error.)

Run: `cd server && npm run build && echo "build ok"`
Expected: `build ok`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): add /api/system/update status and check routes"
```

---

## Chunk 2: Client — Updates card in Settings

### Task 6: "Updates" card with force-check button

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx`

The card follows the existing card pattern in `SettingsPage.tsx` and uses the shared `api` axios instance. No client test framework exists in this repo, so this task verifies via typecheck/build and the Chunk 4 end-to-end run.

- [ ] **Step 1: Add update-status state and types**

At the top of `SettingsPage.tsx`, alongside the existing `ServiceTest` interface, add:

```tsx
interface DeployStatus {
  sha: string | null;
  subject: string | null;
  lastCheck: string | null;
  result: 'up-to-date' | 'updated' | 'failed' | 'unknown';
  error: string | null;
}

type CheckState = 'idle' | 'checking' | 'triggered' | 'not-installed' | 'error';
```

Inside the `SettingsPage` component, add state:

```tsx
const [deploy, setDeploy] = useState<DeployStatus | null>(null);
const [checkState, setCheckState] = useState<CheckState>('idle');

const loadDeployStatus = async () => {
  try {
    const res = await api.get('/system/update/status');
    setDeploy(res.data);
  } catch {
    setDeploy(null);
  }
};

const checkForUpdates = async () => {
  setCheckState('checking');
  try {
    const res = await api.post('/system/update/check');
    if (res.data?.triggered) {
      setCheckState('triggered');
      // The updater may restart the server; re-poll status after a delay.
      setTimeout(loadDeployStatus, 8000);
    } else if (res.data?.reason === 'updater-not-installed') {
      setCheckState('not-installed');
    } else {
      setCheckState('error');
    }
  } catch (err: unknown) {
    // 409 => updater not installed; anything else => generic error
    const status = (err as { response?: { status?: number } })?.response?.status;
    setCheckState(status === 409 ? 'not-installed' : 'error');
  }
};
```

Extend the existing `useEffect(() => { testAll(); }, [])` to also call `loadDeployStatus()`:

```tsx
useEffect(() => {
  testAll();
  loadDeployStatus();
}, []);
```

- [ ] **Step 2: Add the "Updates" card to the JSX**

Add this card inside the `settings-section` div, before the "About" card:

```tsx
<div className="card">
  <h3>Updates</h3>
  <div className="detail-list">
    <div className="detail-row">
      <span className="detail-label">Running</span>
      <span className="detail-value">
        {deploy?.sha
          ? `${deploy.sha}${deploy.subject ? ` — ${deploy.subject}` : ''}`
          : 'Unknown'}
      </span>
    </div>
    <div className="detail-row">
      <span className="detail-label">Last checked</span>
      <span className="detail-value">
        {deploy?.lastCheck
          ? `${new Date(deploy.lastCheck).toLocaleString()} (${deploy.result})`
          : 'Never'}
      </span>
    </div>
  </div>

  <button
    style={{ marginTop: '16px' }}
    onClick={checkForUpdates}
    disabled={checkState === 'checking'}
  >
    {checkState === 'checking' ? 'Checking…' : 'Check for Updates Now'}
  </button>

  {checkState === 'triggered' && (
    <p className="placeholder" style={{ marginTop: '12px' }}>
      Update check started — the dashboard may briefly disconnect if an update
      is applied.
    </p>
  )}
  {checkState === 'not-installed' && (
    <p className="placeholder" style={{ marginTop: '12px' }}>
      The auto-updater isn't installed on this machine.
    </p>
  )}
  {checkState === 'error' && (
    <p className="placeholder" style={{ marginTop: '12px' }}>
      Couldn't start an update check. See the server log for details.
    </p>
  )}
</div>
```

- [ ] **Step 3: Show the real running commit in the About card**

In the "About" card, replace the hardcoded version value:

```tsx
<span className="detail-value">v1.0.0</span>
```

with:

```tsx
<span className="detail-value">{deploy?.sha ? deploy.sha : 'v1.0.0'}</span>
```

- [ ] **Step 4: Typecheck and build the client**

Run: `cd client && npm run build`
Expected: `tsc -b` / `vite build` completes with no type errors and produces `client/dist`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SettingsPage.tsx
git commit -m "feat(client): add Updates card with force-check button"
```

---

## Chunk 3: Deploy scripts

> PowerShell scripts are verified by dry-runs and deliberate-failure checks (Chunk 4), not vitest — the repo has no PowerShell test harness and adding one (Pester) is out of scope. Each script is written to be idempotent and to fail loudly (non-zero exit, logged) rather than silently.

### Task 7: `deploy/update.ps1` — the updater pipeline

**Files:**
- Create: `deploy/update.ps1`

- [ ] **Step 1: Write the script**

Create `deploy/update.ps1`:

```powershell
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
    Runs fetch -> reset -> npm ci -> test -> build but SKIPS the service restart,
    health check, and writing .last-deployed. For testing on the dev PC.
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

function Trim-Log {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
        $keep = Get-Content $LogFile -Tail 2000
        Set-Content -Path $LogFile -Value $keep
    }
}

function Write-Status([string]$result, [string]$sha, [string]$subject, [string]$err) {
    $obj = [ordered]@{
        sha       = $sha
        subject   = $subject
        lastCheck = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        result    = $result
        error     = $err
    }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path $StatusFile -Encoding utf8
}

function Run([string]$exe, [string[]]$args, [string]$cwd) {
    Push-Location $cwd
    try {
        & $exe @args
        if ($LASTEXITCODE -ne 0) { throw "$exe $($args -join ' ') exited $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

Trim-Log

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
    Write-Log "Update: $current -> $remote"

    # 3. Which lockfiles changed? (empty base on first run => treat all as changed)
    $changed = @()
    if ($current) {
        $changed = & git diff --name-only $current origin/main -- `
            package-lock.json server/package-lock.json client/package-lock.json
    }
    $firstRun = [string]::IsNullOrWhiteSpace($current)

    # 4. Update working tree to the target
    Write-Log 'Resetting working tree to origin/main...'
    Run 'git' @('reset', '--hard', 'origin/main') $RepoRoot

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
        Write-Status 'failed' $current (& git log -1 --format='%s' origin/main).Trim() 'health check timed out'
        exit 1
    }

    # 10. Record success LAST
    $subject = (& git log -1 --format='%s' origin/main).Trim()
    Set-Content -Path $LastDeployed -Value $remote
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
```

- [ ] **Step 2: Static-check the script parses**

Run:
```bash
powershell -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('deploy/update.ps1', [ref]$null, [ref]$null); Write-Host 'parsed ok'"
```
Expected: `parsed ok` (no parse errors).

- [ ] **Step 3: Commit**

```bash
git add deploy/update.ps1
git commit -m "feat(deploy): add auto-deploy updater script"
```

> Functional dry-run verification of this script happens in Chunk 4, Task 10.

---

### Task 8: `deploy/install-updater.ps1` — one-time setup

**Files:**
- Create: `deploy/install-updater.ps1`

- [ ] **Step 1: Write the installer**

Create `deploy/install-updater.ps1`:

```powershell
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
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$UpdatePs1`"" `
    -WorkingDirectory $RepoRoot
$atBoot = New-ScheduledTaskTrigger -AtStartup
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($atBoot, $hourly) -Settings $settings -Principal $principal `
    -Description 'Polls origin/main and self-deploys NGConnect (boot + hourly).' | Out-Null
Write-Host "  [OK] Registered '$TaskName' (at boot + every hour)." -ForegroundColor Green

# 4. Confirm the server task exists
if (-not (Get-ScheduledTask -TaskName $ServerTask -ErrorAction SilentlyContinue)) {
    Write-Host "  [WARN] '$ServerTask' task not found. Run install-service.ps1 first." -ForegroundColor Yellow
}

Write-Host ''
$run = Read-Host '  Run an update check now? (Y/n)'
if ($run -ne 'n' -and $run -ne 'N') { Start-ScheduledTask -TaskName $TaskName }
Write-Host '  Done.' -ForegroundColor Green
```

- [ ] **Step 2: Static-check the script parses**

Run:
```bash
powershell -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('deploy/install-updater.ps1', [ref]$null, [ref]$null); Write-Host 'parsed ok'"
```
Expected: `parsed ok`.

- [ ] **Step 3: Commit**

```bash
git add deploy/install-updater.ps1
git commit -m "feat(deploy): add one-time updater installer"
```

---

### Task 9: Fix the latent `NODE_ENV` gap in `install-service.ps1`

The existing server task never actually sets `NODE_ENV=production`; its dead code at lines ~79–83 just re-sets the same arguments. The static client (and thus the Updates button) only serves when `NODE_ENV=production`. Fix it at the source by ensuring `.env` carries the flag and removing the misleading dead code.

**Files:**
- Modify: `install-service.ps1`

- [ ] **Step 1: Ensure `.env` carries NODE_ENV=production**

In `install-service.ps1`, after the `$EnvFile` existence check block (around line 41–43), add:

```powershell
# Ensure NODE_ENV=production so the server serves the built client (index.ts
# gates static serving on NODE_ENV). The task loads .env via --env-file.
if (Test-Path $EnvFile) {
    $envText = Get-Content $EnvFile -Raw
    if ($envText -notmatch '(?m)^\s*NODE_ENV\s*=') {
        Add-Content -Path $EnvFile -Value 'NODE_ENV=production'
        Write-Host '  [OK] Added NODE_ENV=production to .env' -ForegroundColor Green
    }
}
```

- [ ] **Step 2: Remove the misleading dead code**

Delete the block at lines ~79–83 that claims to set `NODE_ENV` but only re-assigns the same arguments:

```powershell
# Set NODE_ENV via the task's environment
# (Scheduled Tasks inherit system env, so we set it in the arguments)
$task = Get-ScheduledTask -TaskName $TaskName
$task.Actions[0].Arguments = "--env-file=`"$EnvFile`" `"$ServerScript`""
Set-ScheduledTask -InputObject $task | Out-Null
```

- [ ] **Step 3: Static-check the script parses**

Run:
```bash
powershell -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('install-service.ps1', [ref]$null, [ref]$null); Write-Host 'parsed ok'"
```
Expected: `parsed ok`.

- [ ] **Step 4: Commit**

```bash
git add install-service.ps1
git commit -m "fix(deploy): reliably set NODE_ENV=production for the server task"
```

---

## Chunk 4: End-to-end verification and rollout

### Task 10: Dry-run the updater on the dev PC

Verifies the happy path and the "up-to-date" fast exit without disturbing anything (no restart, no `.last-deployed` write).

- [ ] **Step 1: Run the updater in dry-run mode**

Run:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/update.ps1 -DryRun
```
Expected: log lines showing fetch → (if `origin/main` moved) reset/ci/test/build, ending with "DryRun: skipping restart…"; exit code 0. If already up to date and no prior `.last-deployed`, it proceeds through build once. `git status` afterward should show a clean tree at `origin/main`.

- [ ] **Step 2: Confirm a status file was written**

Run: `cat deploy/.deploy-status.json`
Expected: JSON with `"result": "updated"` (dry-run writes an `updated` status without touching `.last-deployed`).

- [ ] **Step 3: Confirm no service was touched**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'NGConnect Updater' -ErrorAction SilentlyContinue | Select-Object TaskName"`
Expected: no output on the dev PC (the updater task is only installed on the server PC) — proving the dry-run didn't require or start it.

---

### Task 11: Deliberate-failure check (safety property)

Confirms a bad commit aborts **before** the build/restart and leaves status `failed`.

- [ ] **Step 1: Temporarily break a test**

Create a throwaway failing test at `server/src/services/_failcheck.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
describe('deliberate failure', () => {
  it('fails on purpose', () => { expect(1).toBe(2); });
});
```

- [ ] **Step 2: Run the updater's test+build sequence manually**

Run: `cd server && npm test`
Expected: FAIL (the deliberate test fails). This is the exact command `update.ps1` runs at step 6 — a failure here aborts the pipeline before step 7 (build), so the existing `dist/` is never overwritten.

- [ ] **Step 3: Remove the throwaway test**

Run: `rm server/src/services/_failcheck.test.ts`
Then confirm green: `cd server && npm test`
Expected: PASS.

- [ ] **Step 4: No commit** (the throwaway file is deleted; nothing to commit).

---

### Task 12: Merge to main and roll out on the server PC

- [ ] **Step 1: Merge the feature branch to `main` and push**

```bash
git checkout main
git merge --no-ff feature/auto-deploy -m "feat: auto-deploy from origin/main with dashboard force-check"
git push origin main
```
Expected: push succeeds; `origin/main` now contains the deploy scripts and dashboard changes.

- [ ] **Step 2: On the server PC — pull once, then install the updater**

On the server PC (one-time), pull the new code and run the installer as Administrator:
```powershell
git -C <repo> pull
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\deploy\install-updater.ps1
```
Expected: "Registered 'NGConnect Updater' (at boot + every hour)"; NODE_ENV ensured in `.env`; server task confirmed present.

- [ ] **Step 2a: Verify the button's elevation assumption**

In the dashboard on the server PC, open Settings → Updates → **Check for Updates Now**. Confirm the request returns `triggered: true` (not a 409) — verifying the non-elevated web process can start the elevated updater task. If it 409s as "not installed," re-check the task name matches `NGConnect Updater` exactly.

- [ ] **Step 3: End-to-end smoke test**

On the dev PC, make a trivial visible change (e.g. bump a label), commit, and `git push origin main`. Then either wait for the hourly tick or press "Check for Updates Now" on the server dashboard. Within ~1–2 minutes the server should: fetch, test, build, restart, pass the `/healthz` check, and the Settings "Updates" card should show the new `sha` with result `updated`.

- [ ] **Step 4: Confirm the log**

On the server PC: `Get-Content <repo>\deploy\logs\update.log -Tail 20`
Expected: a "Deployed <sha> successfully." line for the smoke-test commit.

---

## Done criteria

- [ ] Server has `/healthz` (200, unauthenticated, `NODE_ENV`-independent) and `/api/system/update/{status,check}`.
- [ ] `deploy.test.ts` passes and is part of `npm test`.
- [ ] Settings shows the running commit + last-check and a working "Check for Updates Now" button.
- [ ] `deploy/update.ps1` and `deploy/install-updater.ps1` exist; installer registers the boot+hourly task.
- [ ] `install-service.ps1` reliably sets `NODE_ENV=production`.
- [ ] Dry-run passes on the dev PC; deliberate-failure aborts before build; server PC deploys a real push end-to-end and logs success.
