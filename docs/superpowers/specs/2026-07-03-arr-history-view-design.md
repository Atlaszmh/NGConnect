# Arr History View — Design Spec

**Date:** 2026-07-03
**Status:** Approved
**Author:** Zach + Claude

## Problem

The Downloads page's **History** tab reads from SABnzbd (`mode=history`). But
Sonarr/Radarr remove completed downloads from SAB after importing (the
"Remove Completed" download-client setting), so SAB history — and therefore
NGConnect's History tab — ends up empty. There is no durable record of what was
downloaded. Meanwhile Sonarr and Radarr keep their **own permanent history**
(every grab/import/failure) that never gets cleaned up. We want to surface that
durable history in NGConnect.

## Goals

- Replace the Downloads **History** tab's source: instead of SAB history, show a
  combined, durable **Sonarr + Radarr history**.
- Show **imported** and **failed** events (the outcomes) — one row per completed
  download, plus failures.
- Columns: **Title · Type · Event · Quality · Size · Age**.
- Keep the **Queue** tab exactly as-is (live SAB queue is still correct for
  in-flight downloads).
- Degrade gracefully: if one arr is unreachable, show the other's history.

## Non-Goals

- Pagination / "load more" / infinite scroll — v1 shows the recent ~50 combined
  items. Deferred (YAGNI).
- Date-range or text filtering of history.
- Showing `grabbed` events or non-download events (renames, deletions, ignored).
- Changing the Queue tab, or the SAB proxy.
- Retry-from-history (the old SAB-history Retry button goes away; the arrs own
  ret/blocklist of their own failures).

## Real Findings (Sonarr/Radarr v3 `GET /api/v3/history`, from docs)

The arrs are `localhost`-only and unreachable from the dev PC, so — as with the
prior arr work — the normalizer is unit-tested against the **documented shape**
with synthetic records, and the real render is a **user-run check** on the
server PC.

- Paged wrapper: `{ page, pageSize, sortKey, sortDirection, totalRecords,
  records: [...] }`. Query it with `?page=1&pageSize=50&sortKey=date&
  sortDirection=descending` plus `includeMovie=true` (Radarr) /
  `includeSeries=true&includeEpisode=true` (Sonarr) so each record carries the
  resolved title.
- Each record (Radarr `HistoryResource`): `id`, `movieId`, `sourceTitle` (the
  release name), `quality` (`{ quality: { name } }`), `date` (ISO), `downloadId`,
  `eventType`, `data` (a string-map), `movie` (`{ title, year }` when
  `includeMovie`). Sonarr mirrors this with `seriesId`/`episodeId`, `series`
  (`{ title }`), `episode` (`{ seasonNumber, episodeNumber, title }` when
  `includeEpisode`).
- `eventType` is a camelCase string. The download-lifecycle values are
  **`grabbed`**, **`downloadFolderImported`**, **`downloadFailed`** (others:
  `movieFileDeleted`, `episodeFileRenamed`, `downloadIgnored`, …). We keep only
  `downloadFolderImported` → "imported" and `downloadFailed` → "failed".
- Size is not a first-class field; when present it's under `data` (e.g.
  `data.size` / `data.importedPath` context). Treat size as **best-effort**
  (`toInt(record.data?.size)` → bytes, else `null` → render `--`).

## Context (current state)

- **Client** [DownloadsPage.tsx](../../../client/src/pages/DownloadsPage.tsx):
  polls `/sabnzbd/api` for `queue` and `history` every 5s; renders a Queue tab
  (sortable live slots) and a History tab (a table from SAB `history.slots` with
  a Retry button for failed items). `formatDownloaded` etc. are local helpers.
- **Server** [system.ts](../../../server/src/routes/system.ts): the aggregate
  router mounted at `/api/system` (behind `requireAuth`); already fetches from
  services (e.g. `/status` hits Sonarr/Radarr/SAB). `config.sonarr`/`config.radarr`
  hold `{ url, apiKey }`. Arr calls use plain `fetch` with `X-Api-Key`.
- Server tests are vitest, pure-function style. There is no client test harness.

## Architecture Overview

Two units:

1. **`normalizeArrHistory` (new `server/src/services/arrHistory.ts`)** — a pure
   function: given the raw Radarr history JSON and the raw Sonarr history JSON,
   produce a merged, date-sorted `HistoryItem[]` of imported/failed events. All
   the shape-wrangling (movie vs. episode, event mapping, best-effort size)
   lives here and is unit-tested.
2. **`GET /api/system/history` route** — fetches both arrs' recent history,
   calls the normalizer, returns `{ items }`. Handles one-arr-down.
3. **DownloadsPage History tab** — reads `/system/history`, renders the table.

The route knows nothing about record shapes (delegates to the normalizer); the
normalizer knows nothing about HTTP or the UI; the component just renders
`items`.

## Component 1: `server/src/services/arrHistory.ts`

```ts
export interface HistoryItem {
  id: string;                 // `${source}-${record.id}` (stable, unique)
  source: 'radarr' | 'sonarr';
  kind: 'movie' | 'tv';
  title: string;              // clean title; TV gets ' S01E05'; fallback sourceTitle
  event: 'imported' | 'failed';
  quality: string | null;
  sizeBytes: number | null;   // best-effort; null → '--'
  date: string;               // ISO (record.date), '' if absent
}

export function normalizeArrHistory(radarrRaw: unknown, sonarrRaw: unknown): HistoryItem[];
```

**Behavior (pure, never throws):**
- Pull `records` from each raw (`raw.records` if an array, else `[]`). Tolerate
  `null`/non-object/missing `records`.
- Map `eventType`: `downloadFolderImported` → `imported`, `downloadFailed` →
  `failed`; **any other eventType is skipped** (grabbed, renames, etc.).
- Per record:
  - `id`: `` `${source}-${record.id}` ``.
  - Radarr `title`: `movie.title` (+ ` (${movie.year})` if present) → fallback
    `sourceTitle` → `''`.
  - Sonarr `title`: `series.title` + ` S{season}E{ep}` (zero-padded, from
    `episode.seasonNumber`/`episodeNumber` when present) → fallback `sourceTitle`.
  - `quality`: `record.quality?.quality?.name` → `null`.
  - `sizeBytes`: `toInt(record.data?.size)` → `null`.
  - `date`: `record.date` (string) → `''`.
- Merge Radarr + Sonarr items, sort by `Date.parse(date)` **descending**
  (unparseable/empty dates sort last), and return. (No cap here — the route caps;
  keeps the function a pure transform.)

**Unit tests** (`arrHistory.test.ts`), synthetic records in the documented shape:
- Radarr imported record → `{source:'radarr', kind:'movie', event:'imported',
  title:'Movie (2024)', quality, sizeBytes}`.
- Sonarr imported record with episode → title `Series S01E05`.
- A `grabbed` record → filtered out (not in the result).
- A `downloadFailed` record → `event:'failed'`.
- Missing `movie`/`series`/`quality`/`data.size` → falls back to `sourceTitle`,
  `quality:null`, `sizeBytes:null` (no throw).
- Merge + sort: interleaved Radarr/Sonarr dates come out newest-first.
- Malformed input (`null`, `{}`, `{records:'x'}`) → `[]`.

## Component 2: `GET /api/system/history`

Add to `system.ts` (authed, like its siblings):
- Fetch both arrs' recent history in parallel, each best-effort:
  - `GET ${config.radarr.url}/api/v3/history?page=1&pageSize=50&sortKey=date&sortDirection=descending&includeMovie=true` with `X-Api-Key`.
  - `GET ${config.sonarr.url}/api/v3/history?page=1&pageSize=50&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true`.
  - Wrap each fetch in `try/catch` returning `null` on any error, and impose a
    timeout with **`AbortSignal.timeout(10000)`** (the pattern already used for
    arr calls in `healthMonitor.ts`) so a hung/slow arr yields `null` rather than
    stalling the whole request. `Promise.all` the two.
- `const items = normalizeArrHistory(radarrRaw, sonarrRaw).slice(0, 50);`
- Respond `res.json({ items })`. If BOTH fetches failed, still return
  `{ items: [] }` (200) — an empty history is not a 500. (Optionally include a
  `partial: true` flag when exactly one arr failed; the client can ignore it.)
- No API keys in the response (history records carry no keys; nothing to scrub,
  but confirm `sourceTitle`/`data` don't embed one — they don't).

## Component 3: DownloadsPage — History tab from the arrs

- Add a `HistoryItem` interface (mirror the server) and `history` state typed to
  it; drop the SAB `HistorySlot` type and the `mode=history` fetch.
- **Split the two data sources into separate fetch functions + separate state
  and try/catch**, so a history error can never null the queue (today they share
  one `Promise.all`, which couples their failure). `fetchQueue()` sets `queue`;
  `fetchHistory()` sets `history`.
- **Queue tab unchanged.** Keep the 5s poll for the **queue only**
  (`fetchQueue` → `/sabnzbd/api?mode=queue`).
- **History:** `fetchHistory()` reads `/system/history` **on mount** (so the tab
  badge count isn't stale), on switching to the History tab, and on manual
  Refresh — NOT on the 5s poll. Store `items`.
- Render the History table: **Title · Type · Event · Quality · Size · Age**.
  - Type: a badge "Movie"/"TV" from `kind`.
  - Event: `badge-success` "Imported" / `badge-danger` "Failed".
  - Size: a local `formatSize(bytes: number | null)` — **port**, don't literally
    reuse SearchPage's (it returns `'?'`); `null`/0 → `--`, else GB/MB.
  - Age: a local `formatAge(date: string)` — relative ("2 days", "3 mths");
    empty/invalid → `--` (again distinct from SearchPage's `'?'`).
  - `key={item.id}`.
- Remove the SAB-history Retry button and the `retryItem` handler (dead once the
  source changes; the arrs manage their own failures).

## Data Flow

History tab → `GET /api/system/history` → route fetches Radarr + Sonarr
`/history` (parallel, best-effort) → `normalizeArrHistory` (filter to imported/
failed, map to common shape, merge, sort desc) → `{ items }` (cap 50) → table.
Queue tab → `/sabnzbd/api?mode=queue` (unchanged, 5s poll).

## Error Handling

| Case | Behavior |
|---|---|
| One arr unreachable/slow | its fetch → `null`; show the other arr's history. |
| Both arrs unreachable | `{ items: [] }` (200); History shows "No download history". |
| Odd/ò malformed arr JSON | normalizer tolerates → `[]` for that arr; no throw. |
| Record missing title/quality/size | fallbacks (`sourceTitle`/`null`/`--`). |
| Non-import/fail eventType | filtered out by the normalizer. |
| Client fetch error | History tab shows the empty/error placeholder (as today). |

## Testing Strategy

- **Normalizer (real logic):** vitest over synthetic Radarr/Sonarr records per
  the documented shape (the cases above), added to the server suite (`npm test`).
- **Route:** the meaningful logic is the normalizer; a light manual check that
  `/system/history` returns `{ items }` suffices (full auth flow + live arrs =
  the user-run check).
- **Client:** `npm run build` (typecheck) + the user-run check.
- **USER-RUN on the server PC:** open Downloads → History → confirm it lists real
  recent imports from Sonarr/Radarr (Title/Type/Event/Quality/Size/Age), that a
  known recent import (e.g. the earlier test grab) appears, and that the Queue
  tab still works. If a title/size looks wrong, report a sample record and we
  adjust the normalizer.
- **Recommended follow-up (retires the size-field risk):** during that check,
  capture one real Sonarr and one real Radarr `/history` JSON response (nothing
  secret in them — no key scrubbing needed), commit them under
  `server/src/services/__fixtures__/`, and add a fixture-backed regression test
  (as `newznab.test.ts` does). This pins the real `data.size` location. Not a v1
  blocker; do it once we have a real sample.

## Risks / Open Questions

- **Arr history shape unverified live** (esp. where `size` lives, and the exact
  `episode` include field names). Mitigated by best-effort extraction (missing →
  `--`), the documented shape, and the user-run check. If size is consistently
  `--`, we'll find the real field from a sample record and adjust.
- **`pageSize=50` per arr, cap 50 combined** may not show very old history — fine
  for v1 (recent record); pagination is the deferred enhancement.
- **`sortKey`/`includeEpisode` param support** is stable in Sonarr/Radarr v3; if
  an older arr ignores `includeEpisode`, TV rows fall back to `sourceTitle`
  (still useful) — the user-run check will show if that happens.

## Files Touched

**New:**
- `server/src/services/arrHistory.ts` — `HistoryItem` + `normalizeArrHistory`.
- `server/src/services/arrHistory.test.ts` — normalizer unit tests.
- `docs/superpowers/specs/2026-07-03-arr-history-view-design.md` (this file).

**Modified:**
- `server/src/routes/system.ts` — add `GET /history` (fetch both arrs → normalize).
- `client/src/pages/DownloadsPage.tsx` — History tab reads `/system/history`;
  new table; drop the SAB history fetch + Retry.
