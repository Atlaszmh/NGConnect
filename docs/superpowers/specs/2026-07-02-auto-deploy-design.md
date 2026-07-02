# NGConnect Auto-Deploy — Design Spec

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
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
  `npm test` in `server/` runs vitest (12 tests today).
- The server runs in production via an existing **"NGConnect Server"**
  Scheduled Task (`install-service.ps1`), which runs
  `node --env-file=../.env dist/index.js` from `server/`, at boot, with
  auto-restart, listening on `http://localhost:3001`.
- `.gitignore` already ignores `.env`, `config.json`, `*.log`, `dist/`, and
  `node_modules/`. Secrets and build output are therefore never touched by a
  `git reset --hard`.
- In production the server serves the built client at `/` **without auth**;
  the JSON API under `/api/*` (except `/api/auth`) requires auth. So an
  unauthenticated liveness probe should hit `GET /` (not `/api/system/health`).

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
   an optimization). Root first, then `server/`, then `client/`.
6. **Test before building.** `npm test` in `server/`. Tests run from source, so
   a failing test aborts the deploy **before** the known-good `dist/` is
   overwritten. On failure: log, write status (`failed` + error), exit 1. The
   running service is untouched and will be retried next run.
7. **Build.** `npm run build` (client + server). On failure: same handling as
   step 6 — but note `dist/` may now be partially written; the previous run's
   service process keeps its already-loaded code until we restart, and the next
   successful run rebuilds cleanly. (See Risks.)
8. **Restart** the "NGConnect Server" task:
   `Stop-ScheduledTask` then `Start-ScheduledTask` (or `schtasks /end` + `/run`).
9. **Health check.** Poll `GET http://localhost:3001/` for up to ~60s
   (e.g. 20 tries × 3s). Success = any HTTP response. On timeout: log, write
   status (`failed` + "health check timed out"), exit 1. We do **not** roll the
   restart back — the service task itself auto-restarts, and the next run
   retries; worst case the log explains why.
10. **Record success.** Write the new SHA to `deploy/.last-deployed`, write
    status (`updated`, new SHA, commit subject, timestamp), log success, exit 0.

**Ordering guarantees the safety property:** success is persisted only in step
10, so any earlier failure means the next run re-attempts the same target SHA.

**`-DryRun` switch:** runs steps 1–7 (through build) but skips the service
restart (steps 8–9) and does not write `.last-deployed`. Used to test the
script on the dev PC without disturbing anything.

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
4. Print a summary and optionally trigger one immediate run.

## Component 3: Dashboard "Updates" panel

Small addition to the existing app, following current patterns
(`client/src/pages/SettingsPage.tsx` cards + `client/src/services/api.ts`).

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
reset → `npm ci` → test → build → restart "NGConnect Server" → health check →
write `.last-deployed` + `.deploy-status.json`.

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
| Health check times out | Log, write `failed`, exit 1. Service task auto-restarts; retried next run. |
| Button pressed, task absent | API returns `updater-not-installed`; UI shows a clear message. |
| Two runs overlap | Lock + `IgnoreNew`: second logs and exits 0. |

## Testing Strategy

- **`update.ps1` on the dev PC** with `-DryRun`: exercises fetch → reset → ci →
  test → build without restarting anything. Verifies the happy path and the
  "up-to-date" fast exit. (The dev PC is now an identical clone.)
- **Deliberate-failure checks:** temporarily point at a commit with a failing
  test / bad build and confirm the script exits non-zero *before* touching the
  running service, and writes a `failed` status.
- **Server routes:** unit-test `GET /update/status` (missing file → default;
  present file → parsed) with vitest, matching the existing server test style.
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
  any stray local changes — intended, but worth stating so nobody edits code
  directly on the server PC expecting it to persist.

## Files Touched

**New:**
- `deploy/update.ps1`
- `deploy/install-updater.ps1`
- `docs/superpowers/specs/2026-07-02-auto-deploy-design.md` (this file)

**Modified:**
- `.gitignore` — add `deploy/.last-deployed`, `deploy/.deploy-status.json`,
  `deploy/.update.lock` (logs already covered by `*.log`).
- `server/src/routes/system.ts` — two `/update/*` routes.
- `client/src/pages/SettingsPage.tsx` — "Updates" card; use real version.
- Possibly a small server test file under `server/src/**` for the status route.
