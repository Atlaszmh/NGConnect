# Manual Import Scan — Design

**Date:** 2026-07-04
**Status:** Approved by user

## Problem

When an NZB is sent to SABnzbd manually (outside Sonarr/Radarr), the completed
download sits in SAB's completed folder and never gets renamed, moved into the
TV/Movie root folders, or picked up by Plex. Today the only fix is opening
Sonarr/Radarr's own UIs and running a manual import there.

## Goal

One button in NGConnect that makes Sonarr and Radarr scan SAB's completed
folder and auto-import anything they recognize — identical end state to a
download that went through them (renamed, moved to root folder, Plex refresh
via the arrs' existing Plex Connect).

Out of scope (possible phase 2): an interactive matcher UI for badly named
files (Sonarr/Radarr `manualimport` API).

## Approach

Server-orchestrated one-click scan (chosen over a client-only button so the
completed-folder path is never hardcoded, and over an interactive picker per
user preference for one-click auto-scan).

Sonarr and Radarr expose built-in commands for exactly this:
`DownloadedEpisodesScan` (Sonarr) and `DownloadedMoviesScan` (Radarr), each
taking a `path` and `importMode`. Both can safely scan the same folder — each
ignores files that are not its media type.

## Server

New handlers (in `server/src/routes/system.ts`, following the existing
queue-sort endpoint pattern; orchestration logic in a small service module
`server/src/services/importScan.ts` so it is unit-testable).

### `POST /api/system/import-scan`

1. Read SAB's completed folder: call SAB API `mode=get_config&section=misc`,
   take `complete_dir`. This auto-detects the folder (user's manual sends may
   or may not have a category, so the whole completed tree is scanned; the
   arr commands scan recursively). SAB can return a *relative* `complete_dir`
   depending on configuration — validate with `path.isAbsolute` and return the
   502 config error if not absolute.
2. Fire both commands sequentially (Sonarr first, then Radarr — avoids the
   theoretical race of both arrs Move-scanning the same tree concurrently):
   - Sonarr: `POST {sonarr}/api/v3/command` body
     `{ "name": "DownloadedEpisodesScan", "path": <complete_dir>, "importMode": "Move" }`
   - Radarr: `POST {radarr}/api/v3/command` body
     `{ "name": "DownloadedMoviesScan", "path": <complete_dir>, "importMode": "Move" }`
3. Respond `200 { sonarrCommandId, radarrCommandId }`.

### `GET /api/system/import-scan/:sonarrId/:radarrId`

Fetches `GET /api/v3/command/{id}` from each arr and returns
`{ sonarr: { status }, radarr: { status } }` where status is the arr's command
state. Terminal states are `completed`, `failed`, `aborted`, and `cancelled`
(equivalently: anything other than `queued` / `started`). The client polls
this every ~2 s until both are terminal.

### Error handling

- SAB config unreadable, or `complete_dir` missing/empty → `502 { error }`.
- An arr rejects a command → `502 { error }` naming which arr failed. If one
  arr accepted before the other failed, the accepted scan proceeds
  (harmless — scans are idempotent) but the response is still an error so the
  user sees it.
- Poll endpoint: invalid/unknown command IDs → pass through the arr's error as
  `502`.
- Files the arrs cannot identify are left in place. No deletion, no data loss;
  the scan is safely re-runnable at any time.

## Client

`client/src/pages/DownloadsPage.tsx`:

- "Scan download folder" button (lucide `FolderSearch` icon) in the page
  header next to the existing refresh control.
- On click: disable button, show spinner + "Scanning…", `POST
  /api/system/import-scan`, then poll the GET endpoint every 2 s until both
  commands report a terminal state (or a 60-poll safety cap is reached).
- On completion: brief inline success note ("Import scan complete") and
  refresh the existing import-history list, which shows what was imported.
- If the 60-poll cap is hit before both commands are terminal: stop polling,
  show a neutral note ("Scan still running in Sonarr/Radarr — history will
  update when it finishes"), and refresh the history list once.
- On failure: new inline message element near the button (the page has no
  existing inline error state; reuse the `badge-danger` styling for the
  message).

## Known limitation

Auto-import depends on parseable release names (`Show.S01E02.1080p...`).
Well-named NZBs (virtually everything from NZBGeek) import fine; unrecognized
files simply stay in the completed folder. Interactive matching is deferred to
a possible phase 2.

## Testing

- Unit tests for the import-scan service with mocked SAB/arr HTTP responses
  (same style as `server/src/services/deploy.test.ts`): happy path, SAB config
  failure, one-arr-rejects, poll status mapping.
- Live verification must happen on the server PC — Sonarr/Radarr are
  localhost-only there.
