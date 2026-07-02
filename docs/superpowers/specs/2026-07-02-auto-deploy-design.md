# NGConnect Auto-Deploy — Design Spec

**Date:** 2026-07-02
**Status:** Approved
**Author:** Zach + Claude

## Problem

NGConnect is developed on one Windows PC ("dev PC") and runs headless on a
second Windows PC ("server PC"). Today, getting a code change from dev to
server is fully manual. We want: edit and commit on the dev PC, `git push`,
and have the server PC test, build, and restart itself with the new code —
with no interaction on the server PC, plus a way to expedite an update from
the dashboard when needed.

## Goals

- Push to `main` on GitHub → server PC self-updates within the hour.
- Fully headless on the server PC (no prompts, runs at boot + hourly).
- A broken commit must never take the running server down: test before build,
  build before restart, and only record success at the very end.
- A **"Check for Updates Now"** button in the dashboard Settings page to
  expedite a check on demand.
- The updater is version-controlled in the repo, so improvements to it deploy
  the same way as app code.

## Non-Goals

- Instant (sub-minute) deploys. Hourly + on-demand button is sufficient.
- Multi-environment / staging / rollback tooling. The previous good `dist/`
  staying in place on a failed deploy is the only "rollback" needed.
- Deploying to non-Windows targets. The server PC is Windows.
- Making the repo private or using a GitHub Actions self-hosted runner (the
  repo is public; a runner would be unsafe).

## Context (current state)

- Repo: `https://github.com/Atlaszmh/NGConnect.git`, public, default branch
  `main`. Both PCs are now proper git clones tracking `origin/main`.
- Monorepo: root `package.json` orchestrates `client/` (React + Vite) and
  `server/` (Express + TypeScript). `npm run build` builds both;
  `npm test` in `server/` runs vitest (one file, 12 test cases today, all
  passing — verified by running it).
- The server runs in production via an existing **"NGConnect Server"**
  Scheduled Task (`install-service.ps1`), which runs
  `node --env-file=../.env dist/index.js` from `server/`, at boot, with
  auto-restart, listening on `http://localhost:3001`.
- `.gitignore` already ignores `.env`, `config.json`, `*.log`, `dist/`, and
  `node_modules/`. Secrets and build output are therefore never touched by a
  `git reset --hard`.
- **Static client serving is gated on `NODE_ENV === 'production'`**
  (`server/src/index.ts:41`); when off, `GET /` falls through to the 404
  handler. The JSON API under `/api/*` (except `/api/auth`) requires auth, and
  the existing `/api/system/health` is **behind auth** — so there is no
  auth-free, always-on liveness endpoint today. This design **adds one**
  (`GET /healthz`, see Component 3) rather than probing `GET /`, so the health
  gate does not depend on `NODE_ENV` or on the client build being present.
- **Latent bug in `install-service.ps1`:** its comment (line ~79) says it sets
  `NODE_ENV=production` for the "NGConnect Server" task, but the task action is
  just `node --env-file=../.env dist/index.js` — `NODE_ENV` is **never set** by
  the task. So the dashboard client is only served if `.env` happens to contain
  `NODE_ENV=production`. Because our new Settings button lives in that client,
  the client *must* be served on the server PC. This design therefore (a) makes
  the health gate independent of `NODE_ENV` via `/healthz`, and (b) ensures
  `NODE_ENV=production` is reliably set on the server PC (see Component 2).
- **Note:** the repo also contains an *alternate*, unused `node-windows`
  service path (`server/src/service.ts`, which *does* set
  `NODE_ENV=production`). That is **not** the deployed mechanism — the server
  PC runs the "NGConnect Server" **Scheduled Task** — so this design targets and
  fixes the Scheduled Task path only.

## Architecture Overview

Everything new lives under a new `deploy/` folder in the repo plus a small
addition to the existing app (one Settings card + two API routes).

```
deploy/
  update.ps1            # the updater — runs at boot + hourly, and on-demand
  install-updater.ps1   # one-time admin setup on the server PC
  logs/update.log       # gitignored (*.log already covers it)
  .last-deployed        # gitignored — last successfully deployed SHA
  .deploy-status.json   # gitignored — status surfaced to the dashboard
```

Two independent units:

1. **Updater script** (`deploy/update.ps1`) — the whole deploy pipeline. Run
   by a Scheduled Task ("NGConnect Updater"), or on demand when the dashboard
   button triggers that same task. Knows nothing about the web app.
2. **Dashboard Updates panel** — a Settings card + two `/api/system/update/*`
   routes. Reads status the updater wrote; the button triggers the updater
   task. Knows nothing about git internals.

The two communicate only through files the updater owns: `.deploy-status.json`
(updater writes, server reads) and the Scheduled Task (server starts, updater
is the task). This keeps the web process free of any git/build logic and means
scheduled and on-demand runs are byte-for-byte the same code path.

## Component 1: `deploy/update.ps1`

Headless, no prompts. Exit code 0 on "up to date" or "deployed ok", non-zero on
failure. Every run appends to `deploy/logs/update.log` and rewrites
`deploy/.deploy-status.json`.

**Pipeline (each run):**

1. **Single-instance guard.** The Scheduled Task is registered with
   `-MultipleInstances IgnoreNew`. As a belt-and-suspenders against a manual
   invocation overlapping a scheduled one, take an exclusive lock on
   `deploy/.update.lock`; if already held, log "another run in progress" and
   exit 0.
2. **Fetch.** `git fetch origin main`. Compare `origin/main`'s SHA to the SHA
   in `deploy/.last-deployed`. If equal → write status (`up-to-date`,
   timestamp) and exit 0. This is the entire cost of an idle run.
3. **Detect which lockfiles changed** between the current `HEAD` and
   `origin/main` (`git diff --name-only HEAD origin/main`) — remember whether
   root, `server/`, or `client/` `package-lock.json` changed, for step 6.
4. **Update working tree.** `git reset --hard origin/main`. The server's
   checkout is a pure mirror — no local edits are expected there. `.env`,
   `config.json`, `dist/`, and `node_modules/` are gitignored and survive.
5. **Install deps** with `npm ci`, but only in the packages whose
   `package-lock.json` changed in step 3 (always safe to run; skipped only as
   an optimization). Root first, then `server/`, then `client/`. **On the first
   run** (no `.last-deployed`, or it's unreadable), skip the optimization and
   run `npm ci` in all three packages, since there's no reliable prior SHA to
   diff against.
6. **Test before building.** `npm test` in `server/`. Tests run from source, so
   a failing test aborts the deploy **before** the known-good `dist/` is
   overwritten. On failure: log, write status (`failed` + error), exit 1. The
   running service is untouched and will be retried next run.
7. **Build.** `npm run build` (client + server). On failure: same handling as
   step 6 — but note `dist/` may now be partially written; the previous run's
   service process keeps its already-loaded code until we restart, and the next
   successful run rebuilds cleanly. (See Risks.)
8. **Restart** the "NGConnect Server" task: `Stop-ScheduledTask`, then wait for
   port 3001 to be released (poll `Get-NetTCPConnection -LocalPort 3001` until
   clear, up to ~10s, to avoid the old process racing the new one for the
   port). If the port is still held after the wait, fall back to
   `Stop-Process` on the PID that owns 3001 so we never `Start-ScheduledTask`
   against an occupied port. Then `Start-ScheduledTask`.
9. **Health check.** Poll `GET http://localhost:3001/healthz` for up to ~60s
   (e.g. 20 tries × 3s). **Success = HTTP 200** from the always-on liveness
   route (Component 3), which is mounted before auth and independent of
   `NODE_ENV`. A connection refused, timeout, or any non-200 counts as not-yet-
   healthy and is retried within the window. On overall timeout: log, write
   status (`failed` + "health check timed out"), exit 1. We do **not** roll the
   restart back — the service task itself auto-restarts, and the next run
   retries; worst case the log explains why.
10. **Record success.** Write the new SHA to `deploy/.last-deployed`, write
    status (`updated`, new SHA, commit subject, timestamp), log success, exit 0.

**Ordering guarantees the safety property:** success is persisted only in step
10, so any earlier failure means the next run re-attempts the same target SHA.

**`-DryRun` switch:** for safe testing on the dev PC. Runs the lock, fetch,
lockfile-diff, `npm ci`, test, and build against the **current working tree**,
but SKIPS the destructive `git reset --hard` (step 4), the service restart and
health check (steps 8–9), and the `.last-deployed` write (step 10). It still
writes `.deploy-status.json` so the run is observable. Skipping the reset is
what makes it safe to run on a dev checkout without discarding uncommitted or
unpushed local work.

**Logging:** append human-readable lines with timestamps. Before writing, if
`update.log` exceeds ~200 KB, truncate to the most recent ~200 KB so it can't
grow unbounded.

**`.deploy-status.json` shape:**

```json
{
  "sha": "49c5c42",
  "subject": "Update VPN monitor and add vitest for testing",
  "lastCheck": "2026-07-02T14:05:00Z",
  "result": "up-to-date | updated | failed",
  "error": null
}
```

## Component 2: `deploy/install-updater.ps1`

One-time, run as Administrator on the server PC. Idempotent (safe to re-run;
re-registering replaces the task).

1. **Verify prerequisites:** `git` and `node` on PATH; the folder is a git
   clone of the NGConnect repo (if not, fail with a clear message — the server
   PC is already a clone, so this is just a guard).
2. **Register the "NGConnect Updater" Scheduled Task:**
   - Actions: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File
     <repo>\deploy\update.ps1`, working directory = repo root.
   - Triggers: `-AtStartup`, plus a repeating trigger every 1 hour
     (indefinitely).
   - Settings: `-MultipleInstances IgnoreNew`, `-StartWhenAvailable`,
     `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`.
   - Principal: current user, `-LogonType S4U -RunLevel Highest` (elevated, so
     it can restart the server task; matches how "NGConnect Server" is set up).
3. **Confirm** the "NGConnect Server" task exists; if not, tell the user to run
   `install-service.ps1` first.
4. **Ensure `NODE_ENV=production` on the server PC** so the dashboard client
   (and therefore the Settings button) is actually served. Check whether `.env`
   contains a `NODE_ENV=production` line; if not, append it (the server task
   already loads `.env` via `--env-file`, so this is sufficient). This closes
   the latent `install-service.ps1` gap noted in Context without changing the
   server task's action. The gap is also fixed at its source — see Files
   Touched — but the installer guarantees a correct running server regardless.
5. Print a summary and optionally trigger one immediate run.

## Component 3: Dashboard "Updates" panel

Small addition to the existing app, following current patterns
(`client/src/pages/SettingsPage.tsx` cards + `client/src/services/api.ts`).

**Server — one always-on liveness route in `server/src/index.ts`:**

- `GET /healthz` — mounted **before** the auth-protected routes and the
  `NODE_ENV`-gated static block (e.g. right after `express.json()`), returning
  `200 { status: 'ok' }` unconditionally. This is the endpoint the updater's
  health check polls (step 9). It is deliberately unauthenticated, always
  mounted regardless of `NODE_ENV`, and independent of the client build, so it
  is a true "is the new server process up and serving HTTP" gate. Distinct from
  the existing auth-gated `/api/system/health`, which stays as-is.

**Server — two routes in `server/src/routes/system.ts` (authed, like siblings):**

- `GET /api/system/update/status` — read and return `deploy/.deploy-status.json`
  (resolve the path relative to the repo root). If the file is missing, return
  a sensible default (`result: "unknown"`), never error.
- `POST /api/system/update/check` — trigger the updater on demand by spawning
  `schtasks /run /tn "NGConnect Updater"` (via `child_process`). Return
  immediately (fire-and-forget) with `{ triggered: true }`. If `schtasks`
  reports the task doesn't exist, return `{ triggered: false, reason:
  "updater-not-installed" }` with a 200/409 so the UI can show a clear message.
  Do **not** run any git/build logic in the web process.

**Client — an "Updates" card in `SettingsPage.tsx`:**

- On mount, `GET /system/update/status`; show:
  - **Running:** `<sha> — <subject>`
  - **Last checked:** `<relative/absolute time>` (`<result>`)
- **"Check for Updates Now"** button → `POST /system/update/check`, then show
  "Checking… the dashboard may briefly disconnect if an update is applied," and
  re-poll status after a few seconds. If the response says
  `updater-not-installed`, show "Auto-updater isn't installed on this machine."
- This also replaces the hardcoded `v1.0.0` "About" line with the real running
  commit from the status endpoint.

**Why triggering a task (not running git in-process):** on-demand and scheduled
deploys become identical; the elevated task can restart the server even though
the Node web process isn't elevated; and an update that restarts the server
mid-request is fine because the request already returned.

## Data Flow

**Scheduled/boot deploy:**
`git push` (dev) → hourly/boot trigger → `update.ps1` → fetch → (changed?) →
reset → `npm ci` → test → build → restart "NGConnect Server" → health check
(`GET /healthz` == 200) → write `.last-deployed` + `.deploy-status.json`.

**On-demand deploy:**
Settings button → `POST /api/system/update/check` → `schtasks /run "NGConnect
Updater"` → *same* `update.ps1` pipeline as above → status file updated → UI
re-polls `GET /api/system/update/status`.

## Error Handling Summary

| Failure | Behavior |
|---|---|
| No new commits | Write `up-to-date`, exit 0 (the common case). |
| `git fetch` fails (offline) | Log, write `failed`, exit 1. Service untouched; retried next hour. |
| `npm ci` fails | Log, write `failed`, exit 1 **before** build. Old `dist/` intact. |
| `npm test` fails | Log, write `failed`, exit 1 **before** build. Old `dist/` intact. |
| `npm run build` fails | Log, write `failed`, exit 1. Service not restarted; keeps running old loaded code; next run rebuilds. |
| Health check (`/healthz` != 200) times out | Log, write `failed`, exit 1. Service task auto-restarts; retried next run. |
| Button pressed, task absent | API returns `updater-not-installed`; UI shows a clear message. |
| Two runs overlap | Lock + `IgnoreNew`: second logs and exits 0. |

## Testing Strategy

- **`update.ps1` on the dev PC** with `-DryRun`: exercises fetch → ci → test →
  build against the current tree (deliberately **skips** the destructive
  `git reset --hard`, and does not restart the service). Verifies the pipeline
  runs and that a healthy tree builds. (The dev PC is an identical clone.)
- **Deliberate-failure checks:** temporarily point at a commit with a failing
  test / bad build and confirm the script exits non-zero *before* touching the
  running service, and writes a `failed` status.
- **Server routes:** unit-test `GET /update/status` (missing file → default;
  present file → parsed) with vitest, matching the existing server test style.
  Also confirm `GET /healthz` returns 200 without auth and regardless of
  `NODE_ENV`.
- **End-to-end on the server PC:** run `install-updater.ps1`, then make a
  trivial commit on the dev PC, push, and confirm the server updates within the
  hour (or immediately via the button). Verify the elevated-task-restart
  assumption holds when the button is pressed from the non-elevated web process.

## Risks / Open Questions

- **Partial `dist/` after a failed build (step 7).** A build that fails
  midway could leave `dist/` inconsistent on disk, though the *running* process
  keeps its already-loaded code until restarted. Mitigation: build failures
  abort before restart, and the next successful run rebuilds from clean source.
  If this proves flaky, a future improvement is building to a temp dir and
  swapping on success — deferred (YAGNI) unless observed.
- **On-demand trigger elevation.** Starting an elevated Scheduled Task from the
  non-elevated web process should work (starting ≠ modifying), but this is the
  one assumption to confirm during end-to-end testing.
- **Server-checkout drift.** The design assumes the server checkout is never
  hand-edited (it's a mirror). `git reset --hard` enforces this by discarding
  any stray local *tracked* changes — intended, but worth stating so nobody
  edits code directly on the server PC expecting it to persist. Note
  `git reset --hard` does **not** remove *untracked* files; if an upstream
  commit ever adds a file that already exists untracked on the server, the
  checkout could fail. We deliberately do **not** run `git clean` (it would
  delete gitignored runtime files like `.env`); if such a collision ever
  occurs, the deploy fails loudly (logged, service untouched) rather than
  silently — acceptable for a pure mirror, and resolvable by hand.

## Files Touched

**New:**
- `deploy/update.ps1`
- `deploy/install-updater.ps1`
- `docs/superpowers/specs/2026-07-02-auto-deploy-design.md` (this file)

**Modified:**
- `.gitignore` — add `deploy/.last-deployed`, `deploy/.deploy-status.json`,
  `deploy/.update.lock` (logs already covered by `*.log`).
- `server/src/index.ts` — add the always-on unauthenticated `GET /healthz`
  route (before auth and the `NODE_ENV` static block).
- `server/src/routes/system.ts` — two `/update/*` routes.
- `client/src/pages/SettingsPage.tsx` — "Updates" card; use real version.
- `install-service.ps1` — fix the latent `NODE_ENV` gap at its source: set
  `NODE_ENV=production` for the "NGConnect Server" task reliably (e.g. ensure
  the `.env` it loads contains it, and correct the misleading comment/dead code
  at lines ~79–83). This makes production static-serving dependable rather than
  accidental. (`install-updater.ps1` also guarantees it at setup time, per
  Component 2 — belt and suspenders.)
- A small server test file under `server/src/**` for the status and `/healthz`
  routes.
