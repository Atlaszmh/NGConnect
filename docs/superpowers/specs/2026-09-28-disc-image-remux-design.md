# Convert Disc Images for Plex — Design

**Date:** 2026-09-28
**Status:** Approved by user

## Problem

Radarr accepts DVD/Blu-ray disc images (`.iso`/`.img`, qualities `DVD-R` and
`BR-DISK`) as movie files. Plex deliberately skips disc images, so those movies
import "successfully" but never appear in Plex. Two are in the library today:
Puss in Boots: The Last Wish (DVD9 ISO, 8 GB, runtime 103 min) and Dune 2021
(Blu-ray ISO, 48 GB, runtime 155 min).

## Goal

A **Convert for Plex** button on disc-image movies (Movies page) that, from the
dashboard alone, remuxes the disc's main feature into an MKV (no re-encode),
swaps it in for the disc image in Radarr, and gets it into Plex. DVD and
Blu-ray images are both in scope.

Out of scope: automatic conversion on import, TV (Sonarr) disc images, choosing
a title manually, cancelling a running job, re-encoding/compression.

## Constraints discovered

- NGConnect runs on the server PC as the "NGConnect Server" scheduled task, as
  the user, `RunLevel Highest` — it can spawn ffmpeg.
- ffmpeg's `dvdvideo` demuxer (libdvdnav/libdvdread) reads a DVD ISO directly —
  no mounting — and emits chapters and the correct subtitle palette. The
  `bluray:` protocol (libbluray) reads a Blu-ray and, with no `-playlist` given,
  **selects the longest playlist itself** (verified in `libavformat/bluray.c`).
- The gyan.dev *essentials* build lacks libdvdnav/libbluray; the *full* build
  (what `winget install Gyan.FFmpeg` installs) has both.
- **Radarr's recycle bin is not configured**, so any delete of the ISO is
  permanent. The ISO must not be deleted until the MKV is imported.
- Radarr's `ManualImport` command builds an `ImportDecision` with no rejection
  checks (so a DVD MKV replacing a DVD-R ISO is not refused as "not an
  upgrade"), and the old file is removed inside `UpgradeMovieFile` during that
  same import. When the source is outside the movie folder the import counts as
  a new download: history gets `downloadFolderImported` and the Plex
  notification (onDownload/onUpgrade, enabled) fires.
- Radarr quality ids: `DVD`=2, `Remux-1080p`=30, `Remux-2160p`=31 (looked up
  by name at runtime from `/qualitydefinition`, not hard-coded).
- SAB `complete_dir` is `R:\Torrents\ModernTorrents\completed`, the same volume
  as the Movies root (163 GB free today).

## Design

### Server — `server/src/services/discRemux.ts`

One in-memory job at a time (global lock). Job shape:

```ts
{ movieId, title, stage: 'probing'|'remuxing'|'verifying'|'importing'|'done'|'failed',
  percent: number|null, message: string|null, startedAt, finishedAt }
```

Flow for `startRemux(movieId)` — the lock is claimed synchronously before the
first `await` (released again if validation fails, so two near-simultaneous
POSTs cannot start two jobs); the route validates (steps 1–3) and returns
`202`; steps 4–8 run in the background inside a catch-all that always ends the
job as `done` or `failed` and releases the lock:

1. **Load** the movie from Radarr; require a movie file ending `.iso`/`.img`.
   Remember `movieFile.id` and `movieFile.releaseGroup`.
2. **Locate ffmpeg**: `FFMPEG_PATH` env, else `ffmpeg` on PATH; `ffprobe` from
   the same directory, else PATH. It is "ok" only if `-demuxers` lists
   `dvdvideo` AND `-protocols` lists `bluray` (the full build has both; the disc
   type is not known until probing). A successful check is cached.
3. **Free space**: the staging volume must have ISO size + 1 GB free
   (`fs.statfs`).
4. **Probe** (`probing`) → `{ kind, title?, sourceSeconds, height }`:
   - DVD: ffprobe `-f dvdvideo -title N -i <iso>` for N = 1..99, each with a
     30 s timeout (killed → that title is skipped). Failure output is
     classified: `Unable to open the VMG` / `Unable to open the DVD-Video
     structure` → not a DVD, go to Blu-ray; `Title <N> not found` → past the
     last title, stop; anything else → skip that title. Pick the longest title.
     No title opened → try Blu-ray.
   - Blu-ray: ffprobe `-v info -show_entries stream=codec_type,height -of json
     -i bluray:<iso>`. stderr carries libbluray's `playlist NNNNN.mpls (h:mm:ss)`
     lines and `selected NNNNN.mpls`; the selected playlist's duration is
     `sourceSeconds`. stdout JSON gives the video `height`. (ffmpeg ignores
     playlists under 3 min — `MIN_PLAYLIST_LENGTH` — irrelevant for features.)
   - Neither opens → `failed` ("not a readable DVD or Blu-ray image").
5. **Name**: `release = <Title>.<Year>.DVD` for DVDs, or
   `<Title>.<Year>.<1080p|2160p>.BluRay.REMUX` for Blu-rays (2160p when height >
   1080). `<Title>` is Radarr's title with characters invalid in Windows file
   names removed and spaces → dots (e.g. `Puss.in.Boots.The.Last.Wish.2022.DVD`).
   These names parse to the same quality Radarr is told explicitly in step 8,
   so a manual "Scan download folder" recovery labels the file correctly.
   Staging path: `<complete_dir>\ngconnect-remux\<release>\<release>.mkv`.
6. **Remux** (`remuxing`) with ffmpeg stream copy into `<staging>.partial`
   (`-f matroska`; the `.partial` extension keeps the dashboard's "Scan download
   folder" from importing a half-written file):
   - DVD: `-f dvdvideo -title <N> -i <iso>`
   - Blu-ray: `-i bluray:<iso>` (longest playlist auto-selected)
   - both: `-nostdin -y -map 0:v -map 0:a -map 0:s? -c copy
     -max_muxing_queue_size 4096 -progress pipe:1 -nostats` (`-y` overwrites a
     `.partial` left by an interrupted run; `-nostdin` + stdin `ignore` so
     ffmpeg can never block on a prompt)
   Percent = `out_time_us` / `sourceSeconds`, capped at 99 until ffmpeg exits.
   Spawn error, non-zero exit, or a watchdog trip (no `out_time_us` advance for
   5 min → kill) → delete the partial, `failed` (last stderr line as the
   message).
7. **Verify** (`verifying`): ffprobe the partial. Pass only if it has a video and
   an audio stream AND its duration is ≥ 97% of `sourceSeconds` (catches
   truncated reads of a damaged image) AND within 80%–130% of Radarr's runtime
   (catches a wrong title/playlist; skipped if Radarr has no runtime). Fail →
   delete the partial, `failed`, ISO untouched. Pass → rename to `.mkv`.
8. **Import** (`importing`): re-read the movie; if its `movieFile.id` changed
   since step 1 (a grab/upgrade/removal happened during the remux) → `failed`,
   MKV left in staging. Otherwise `POST /api/v3/command`
   `{ name: 'ManualImport', importMode: 'Move', files: [{ path, movieId,
   folderName: <release>, quality: { quality: <definition>, revision:
   { version: 1, real: 0, isRepack: false } }, languages: [], releaseGroup }] }`
   with quality `DVD` / `Remux-1080p` / `Remux-2160p` looked up by name from
   `/qualitydefinition`. Poll the command every 3 s for up to 60 min (a
   cross-volume move of a Blu-ray remux can take a while); timeout → `failed`
   ("check Radarr > Activity"). Then re-read the movie: `done` only if its file
   now ends in `.mkv`; else `failed` with the MKV path in the message. On
   success remove the staging folder with a best-effort, non-recursive `rmdir`
   (never takes a leftover file with it; ENOENT/ENOTEMPTY ignored so cleanup
   can't turn `done` into `failed`).

Every failure path leaves either the untouched ISO or a verified MKV in
staging on disk.

Pure helpers (unit-tested): disc-image detection, DVD title-probe result
classification + longest pick, libbluray playlist-log parsing, release naming,
ffmpeg argument building, `-progress` line parsing, the verification rule,
quality choice.

### Endpoints (in `routes/system.ts`, next to import-scan)

- `GET /api/system/remux` → `{ ffmpeg: { ok, dvd, bluray, hint }, job }`
- `POST /api/system/remux` `{ movieId }` → `202 { job }`; `409` if a job is
  running; `400` bad id or the movie's file is not a disc image; `503` if
  ffmpeg is not ok (step 2); `507` if free space is short.

### Client — Movies page

- `movieFile.relativePath` added to the `Movie` type; `.iso`/`.img` → warning
  badge "Disc image" (tooltip: "Plex can't play disc images").
- Disc-image cards get a **Convert for Plex** button in the poster overlay next
  to Search/Remove. Native confirm first (states it replaces the disc image in
  Radarr and takes a while).
- On mount the page reads `GET /system/remux`; while a job is active it polls
  every 3 s. The converting card's button shows the stage and percent; other
  Convert buttons are disabled, and Search/Remove are disabled on the card
  being converted. When a polled job moves from active to `done` the movie
  list refetches (badge disappears) — a `done` job already in memory on mount
  does not trigger a refetch. On `failed` the message shows on that card.
- ffmpeg missing → Convert disabled, tooltip gives the one-time setup command.

### One-time setup on the server PC

`winget install Gyan.FFmpeg`, then restart NGConnect (or let the next
auto-deploy restart it). If the task still can't find it, set `FFMPEG_PATH`
in `.env` to the full path of `ffmpeg.exe`.

## Recommended (not built): Radarr recycle bin

Radarr's recycle bin is off, so the ISO Radarr removes during the import is
deleted permanently. Setting Radarr > Settings > Media Management > Recycling
Bin to a folder on R: (cleanup is already 7 days) makes that recoverable with
zero code. The title is also re-downloadable through the normal Search flow.

## Known limits (marked `ponytail:` in code)

- Job state is in memory: a server restart (e.g. an auto-deploy) mid-job loses
  it and leaves a `.partial` behind; re-running overwrites it.
- Copy-protected DVDs with many decoy titles can defeat "longest title"; the
  runtime check catches truncated/wrong-length picks but not a same-length decoy.
- Blu-ray remuxes carry no chapters or track language tags (ffmpeg's `bluray:`
  protocol feeds a bare MPEG-TS). DVD remuxes keep both.
- The Blu-ray path was verified locally against a single-playlist test ISO;
  longest-playlist selection on a real multi-playlist disc is ffmpeg's own code
  and is first exercised live (Dune).

## Testing

- vitest for the pure helpers.
- Local end-to-end runs (done during design, repeat against the final code):
  - DVD: a 3-title DVD-Video ISO (20 s / 60 s with 2 audio tracks and 3
    chapters / 10 s) authored in WSL with dvdauthor + genisoimage. Probing
    gives 20 / 59.97 / 10 s and `Title 4 not found`; remuxing title 2 gives a
    60.03 s MKV with both AC3 tracks and 3 chapters.
  - Blu-ray: a 4-min 1080p H.264 + AC3 ISO authored with tsMuxer 2.7.0. The
    probe logs `playlist 00000.mpls (0:04:00)` / `selected 00000.mpls` and
    height 1080; the remux gives a 240.03 s MKV.
- The Radarr swap is exercised live on the server PC only, with the user's
  go-ahead (it replaces a library file). Before the first live run, enable
  Radarr's recycle bin (see above) so the replaced ISO is recoverable.

## Supersedes

The uncommitted `tools/remux-dvd-iso.ps1` (mount + delete-first ordering) is
deleted.
