# NGConnect Auto-Deploy (server PC)

Self-updating deploy for the server PC. On boot and every hour, and on demand
via the dashboard, the server polls `origin/main`; if it changed, it tests,
builds, and restarts itself into the new commit.

## How it works

Two Windows Scheduled Tasks (both run as the current user, `RunLevel Highest`,
`S4U`):

| Task | Trigger | What it does |
|---|---|---|
| **NGConnect Server** | At startup | Runs `node --env-file=.env server/dist/index.js` (serves :3001) |
| **NGConnect Updater** | At startup + every hour | Runs `deploy/update.ps1` |

`deploy/update.ps1`: `git fetch` → if `origin/main` moved → `git reset --hard`
→ `npm ci` (only changed lockfiles; all three on first run) → `npm test`
(server) → `npm run build` → stop/start **NGConnect Server** → health-check
`GET http://localhost:3001/healthz` (200, up to ~60s). Success is recorded
**last** (`.last-deployed`, `.deploy-status.json`), so any failure leaves the
last-good build running and is retried next run.

The dashboard **Settings → Updates → Check for Updates Now** button triggers the
**NGConnect Updater** task on demand (a non-elevated web server starting the
elevated task — verified working).

## First-time install (elevated PowerShell)

The server runs as the **NGConnect Server** scheduled task, NOT the old
node-windows service. If the node-windows service (`ngconnect.exe`) is still
installed, remove it first so the two don't fight over port 3001:

```powershell
cd C:\Users\Dragon\Documents\Projects\NGConnect\server
npm run service:uninstall
Get-Service ngconnect* -ErrorAction SilentlyContinue   # should return nothing
```

Then register both tasks:

```powershell
# 1. Server task (needs server\dist built at least once; the updater rebuilds after)
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Dragon\Documents\Projects\NGConnect\install-service.ps1
#    verify: (Invoke-WebRequest http://localhost:3001/healthz -UseBasicParsing).StatusCode  -> 200

# 2. Updater task (boot + hourly). Prints "repetition PT1H confirmed" on success.
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Dragon\Documents\Projects\NGConnect\deploy\install-updater.ps1
```

Order matters: uninstall node-windows → install server task → install updater.

## Verify / observe

```powershell
# tail the updater log (Ctrl+C to stop)
Get-Content C:\Users\Dragon\Documents\Projects\NGConnect\deploy\logs\update.log -Wait -Tail 20

# current status the dashboard reads
Get-Content C:\Users\Dragon\Documents\Projects\NGConnect\deploy\.deploy-status.json
```

A healthy first run ends with `Deployed <sha> successfully.` Every hourly run
after that logs `Up to date at <sha>` and exits in ~1s.

## Failure behavior (deliberate trade-off)

- A commit that fails **build or test** never reaches the server — the test gate
  runs before the build, so `dist/` is never overwritten with a bad commit.
- A commit that **builds fine but crashes at runtime** restarts into the bad
  build with **no automatic rollback**. Recover by pushing a fix (it deploys on
  the next run, or immediately via the button). Kept simple on purpose.

## Gotchas

- **Stale compiled test files in `dist/` fail the test gate.** `server/tsconfig.json`
  excludes `**/*.test.ts`, but `tsc` never cleans `dist/`, and `dist/` is
  gitignored so `git reset --hard` won't remove pre-existing `*.test.js`. Vitest
  then collects them as CommonJS and `npm test` exits 1, blocking every deploy.
  Fix once: `find server/dist -name '*.test.*' -delete` (already done during the
  2026-07-02 migration; new builds won't reintroduce them).
- The **first updater run** has no `.last-deployed`, so it does a full `npm ci` +
  build + restart even when nothing changed, then writes the baseline.
- `deploy/logs/`, `.deploy-status.json`, `.last-deployed`, `.update.lock` are
  runtime artifacts (gitignored).

## Daily workflow

Edit on the dev PC → commit → `git push`. The server updates itself within the
hour, or immediately via **Settings → Updates → Check for Updates Now**.
