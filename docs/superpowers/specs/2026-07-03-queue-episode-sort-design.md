# Queue Episode-Order Sort — Design Spec

**Date:** 2026-07-03
**Status:** Approved
**Author:** Zach + Claude

## Problem

When a show is grabbed as individual episodes (e.g. season monitoring searches
and grabs several single-episode releases), SABnzbd downloads them in whatever
order they landed in the queue — not episode order. Since SAB downloads
top-to-bottom, the result is that you can't reliably start watching E01 while the
rest finish. The user wants a show's episodes to download in chronological
(season → episode) order, unattended.

## Goals

- Keep the SABnzbd queue ordered so each show's **episodes download in
  season→episode order**, continuously and **headless** (no browser needed).
- Group a show's episodes together (relative to other shows) while **leaving
  non-episode items — movies, season packs, unparseable names — exactly where
  they are** in the queue (no starvation of movies behind a TV backlog).
- Expose an **on/off toggle** on the Downloads page (default ON), so the user can
  disable it to hand-arrange the queue by dragging.

## Non-Goals

- Sorting across download clients other than SABnzbd, or anything on the History
  tab.
- Per-episode *download-priority* tuning beyond queue position.
- Cross-referencing Sonarr/Radarr for episode metadata (we parse the SAB
  filename — see Approach). Daily-dated and absolute-numbered (anime) releases
  that lack `SxxEyy` are intentionally treated as non-episodes.
- Persisting the toggle across server restarts (in-memory, default ON — mirrors
  the existing VPN kill-switch config; a restart re-enables it, which is the
  intended default).
- Changing how grabs enter the queue, or the existing drag-to-reorder mechanism
  itself (only disabled in the UI while the toggle is ON).

## Context (current state)

- **Downloads page** (`client/src/pages/DownloadsPage.tsx`) fetches the queue
  directly from SABnzbd via `GET /sabnzbd/api?mode=queue`; each slot carries
  `nzo_id`, `filename`, `cat`, `percentage`, etc. — **no structured
  season/episode**.
- **Reorder primitive already works:** the page has drag-to-reorder (`@dnd-kit`)
  that persists a move with `GET /sabnzbd/api?mode=switch&value=<nzo_id>&value2=<index>`.
  `value2` is the target position; the existing code trusts SAB to insert-at that
  index and shift the rest.
- **Background-monitor pattern exists:** `server/src/services/vpnMonitor.ts` is a
  module with an in-memory config (`{ enabled, pollIntervalMs, … }`),
  `getKillSwitchConfig()/updateKillSwitchConfig(partial)`, a `setInterval` poll
  loop with `try/catch`, `start…/stop…` functions, and a **pure, unit-tested**
  parse helper (`parseVpnStatus`). Started from `index.ts`.
- **Toggle-config route pattern exists:** `server/src/routes/system.ts` exposes
  `GET /vpn/killswitch` and `PUT /vpn/killswitch` over that in-memory config.
- **SAB proxy** (`server/src/routes/sabnzbd.ts`) forwards arbitrary query params
  to `${sabnzbd.url}/api` with the key server-side.
- Sonarr/Radarr/SAB are **localhost-only on the server PC** → any live queue test
  is user-run on the server PC (dev PC can build + run unit tests only).

## Approach: filename parsing (chosen)

Parse season/episode from the SAB `filename` with a regex, rather than
cross-referencing Sonarr's queue. The filename is already in the payload we
fetch; every SAB item now originates from a Sonarr/Radarr grab, so names are
standardized `Show.Name.SxxEyy…`. This keeps the feature self-contained, adds no
arr coupling, and makes the core logic a set of **pure functions** (the
codebase's established, unit-tested style). Items that don't match `SxxEyy` are
treated as non-episodes and left in place.

## Architecture Overview

A server-side background loop (mirroring `vpnMonitor`) keeps the SAB queue sorted;
a small toggle config controls it; the Downloads page renders a switch. Three
**pure functions** hold all the real logic and are unit-tested; the loop and the
SAB HTTP calls are thin I/O around them.

## Component 1: `server/src/services/queueSort.ts`

### Pure functions (unit-tested)

**`parseEpisode(filename: string): { show: string; season: number; episode: number } | null`**
- Regex on `SxxEyy`, case-insensitive, tolerating `.`/`_`/space separators, e.g.
  `/^(?<show>.*?)[._ -]+s(?<s>\d{1,2})e(?<e>\d{1,3})/i`.
- `show` = the prefix before `SxxEyy`, normalized (replace `._` with spaces,
  collapse whitespace, trim, lowercase) — used only as a grouping key.
- Multi-episode names (`S01E01E02`, `S01E01-E02`) → use the **first** episode.
- No match (movies, season packs like `S01` with no `E`, daily `2024.01.15`,
  absolute-numbered anime) → `null`.

**`episodeSortOrder(slots: { nzo_id: string; filename: string }[]): string[]`**
Produces the **desired** `nzo_id` order under the "non-episodes hold their
position" rule:
1. Classify each slot via `parseEpisode`: *episode* or *non-episode*.
2. **Non-episode items are fixed points:** `desired[currentIndex] = item`.
3. The remaining indices (ascending) are the *episode slots*.
4. Sort the episode items by: **show-group order**, then season, then episode.
   Show-group order = ascending by the **minimum current index** among that
   show's episodes (so the show whose topmost episode sits highest comes first;
   deterministic and stable).
5. Fill the episode slots (in ascending index order) with the sorted episode
   list. Return the length-N `nzo_id` array.

This gathers+orders each show's episodes among themselves while every
non-episode keeps its absolute queue index (a movie at index 2 stays at index 2;
episodes reorder around it).

**Grouping-key note:** grouping is purely by the normalized `show` string, so two
genuinely different shows whose names normalize identically would be merged into
one group (and one show under two spellings that normalize differently would form
two groups). With standardized arr filenames this is a non-issue in practice
(see Non-Goals); the rule stays deterministic either way.

### Worked examples (canonical `episodeSortOrder` fixtures)

**Multi-show + a held movie** — grouping and ordering around a fixed non-episode:
```
current                          desired
0  ShowB S01E02                  0  ShowB S01E01
1  ShowA S01E01                  1  ShowB S01E02
2  Movie            (fixed →)    2  Movie
3  ShowB S01E01                  3  ShowA S01E01
4  ShowA S01E02                  4  ShowA S01E02
```
Movie is fixed at index 2. Episode slots = {0,1,3,4}. Show order by min current
index: ShowB (min 0) before ShowA (min 1). Sorted episodes fill the freed slots.

**One show split by a held movie** — episodes end up ordered but non-contiguous:
```
current                          desired
0  ShowA S01E03                  0  ShowA S01E01
1  Movie            (fixed →)    1  Movie
2  ShowA S01E01                  2  ShowA S01E02
3  ShowA S01E02                  3  ShowA S01E03
```
Movie holds index 1; ShowA's E01/E02/E03 fill slots {0,2,3} in order — so E01 sits
above the movie and E02/E03 below it. This is the intended "hold position"
tradeoff, not a bug.

**`planMoves(currentIds: string[], desiredIds: string[]): { nzo_id: string; position: number }[]`**
- Transforms `current` → `desired` as a minimal sequence of "move item to
  position i" ops (each maps 1:1 to a SAB `switch` call). Walk `i = 0…N-1`; if
  the working array already has `desired[i]` at `i`, skip; else find it later in
  the working array, splice it to `i`, and emit `{ nzo_id: desired[i], position: i }`.
- Returns `[]` when `current` already equals `desired` → **the loop issues zero
  SAB calls when nothing is out of place** (idempotent; no churn once sorted).

### Loop + config (thin I/O, not unit-tested — live)

- In-memory `queueSortConfig = { enabled: true, pollIntervalMs: 15000 }` with
  `getQueueSortConfig()` and `updateQueueSortConfig(partial)` (restart the
  interval if the interval changed) — the kill-switch shape. `updateQueueSortConfig`
  **clamps `pollIntervalMs` to a floor** (e.g. `Math.max(5000, …)`) so a bad
  `PUT` value can't make the loop hammer SAB.
- `startQueueSorter()/stopQueueSorter()` — `setInterval(tick, pollIntervalMs)`.
- `tick()`: if `!enabled`, return. Fetch `mode=queue` from SAB (key server-side).
  Build `slots` (`nzo_id`, `filename`), compute `desired = episodeSortOrder(slots)`,
  `moves = planMoves(currentIds, desired)`; for each move call
  `mode=switch&value=<nzo_id>&value2=<position>`. Wrap in `try/catch` → log and
  skip the tick on any error (SAB unreachable, etc.). Reorders even when the
  queue is paused (sets order for when it resumes).

## Component 2: route — `server/src/routes/system.ts`

Mirror the kill-switch endpoints:
- `GET /system/queue-sort` → `getQueueSortConfig()`.
- `PUT /system/queue-sort` → `updateQueueSortConfig(req.body)` then return the
  config. Body: `{ enabled?: boolean; pollIntervalMs?: number }` (validate types;
  ignore unknown keys). Note: this is **stricter than** the mirrored
  `PUT /vpn/killswitch`, which passes `req.body` through unvalidated — validate
  here rather than copy-pasting that handler. The floor-clamp lives in
  `updateQueueSortConfig` (above), so the route need only type-check.

## Component 3: wiring — `server/src/index.ts`

Call `startQueueSorter()` alongside `startVpnMonitor()` at startup.

## Component 4: client — `client/src/pages/DownloadsPage.tsx`

- On mount, `GET /system/queue-sort` → `enabled` state. Render a **"Keep in
  episode order"** toggle in the Queue tab header; on change, `PUT` the new value
  (optimistic).
- While `enabled`, **disable the drag handles** (the server would undo manual
  drags within one tick). While disabled, drag works exactly as today.
- The page's existing 5 s queue poll already reflects the server-applied order —
  the client does **no** sorting itself; it only renders and toggles.

## Data Flow

SAB grabs episodes out of order → server `tick()` (≤15 s) fetches the queue →
`episodeSortOrder` computes the desired order (episodes gathered/ordered,
non-episodes fixed) → `planMoves` yields switch ops → SAB `switch` calls reorder
the real queue → SAB downloads top-to-bottom in episode order → Downloads page
poll shows the sorted queue. Toggle OFF → `tick()` no-ops and drag re-enables.

## Error Handling

| Case | Behavior |
|---|---|
| Toggle OFF | `tick()` returns immediately; no SAB calls; drag re-enabled in UI. |
| SAB unreachable / error | `try/catch` logs and skips the tick; retries next interval. |
| Empty or single-item queue | `planMoves` returns `[]`; no-op. |
| Already sorted | `planMoves` returns `[]`; **zero** switch calls. |
| Paused queue | Still reordered (order applies when resumed). |
| Multi-episode file (`S01E01E02`) | Sorted by the first episode. |
| Unparseable / movie / season pack | Treated as non-episode; index held. |

## Testing Strategy

- **`parseEpisode` (pure):** standard `S01E05`; lowercase `s1e5`; dot vs space vs
  underscore separators; multi-episode `S01E01E02` → episode 1; season pack `S01`
  → null; movie `Movie.Name.2021.1080p` → null; daily `Show.2024.01.15` → null;
  a separator between the S- and E- blocks (`S01.E01`) — assert the intended
  behavior explicitly (the immediate-`e` regex treats it as non-episode → null);
  show-name normalization.
- **`episodeSortOrder` (pure):** the multi-show before→after example (ShowB/ShowA
  interleaved → grouped+ordered); non-episode held at its absolute index while
  episodes reorder around it; already-sorted input returns the same order;
  single show out of order → ordered.
- **`planMoves` (pure):** equal arrays → `[]`; one item out of place → one move;
  fully reversed → correct sequence; a move sequence that reproduces `desired`
  when replayed.
- **Client:** `npm run build` (typecheck) is the gate (no client test harness).
- **USER-RUN on the server PC** (SAB is localhost-only): with the toggle ON, get
  a show's episodes into the queue out of order (or drag them out of order) and
  confirm SAB reorders them to E01→E02→… within ~15 s and downloads in that
  order; confirm a movie in the queue **keeps its position**; toggle OFF and
  confirm a manual drag now persists. Verify the two SAB-behavior unknowns:
  reordering the **actively-downloading** item is not disruptive, and **priority
  tiers** don't fight the `switch` positions. Watch specifically for the queue
  **never settling** — continuous `switch` calls tick after tick (visible in the
  server log) — as a distinct failure mode from "wrong order"; it would mean SAB's
  post-switch order disagrees with `episodeSortOrder` (e.g. priority tiers
  reshuffling), which we'd address by excluding non-default-priority items.

## Risks / Open Questions

- **SAB `switch` position semantics** (insert-at-index vs swap) are assumed from
  the existing drag code; if they differ, the loop still **converges** over
  successive ticks (it recomputes each time). Confirmed by the live check.
- **Priority tiers:** SAB may keep Force/High-priority items in their own tier;
  `switch` within a tier should still order episodes, but cross-tier ordering is
  SAB-controlled — noted for the live check.
- **Filename parsing** can't order daily/absolute-numbered releases; these fall
  back to "non-episode, hold position," which is acceptable per Non-Goals.

## Files Touched

**New:**
- `server/src/services/queueSort.ts` — `parseEpisode`, `episodeSortOrder`,
  `planMoves`, config + loop.
- `server/src/services/queueSort.test.ts` — unit tests for the three pure
  functions.
- `docs/superpowers/specs/2026-07-03-queue-episode-sort-design.md` (this file).

**Modified:**
- `server/src/routes/system.ts` — `GET`/`PUT /system/queue-sort`.
- `server/src/index.ts` — start the sorter loop.
- `client/src/pages/DownloadsPage.tsx` — toggle UI + fetch/update; disable drag
  while enabled.
