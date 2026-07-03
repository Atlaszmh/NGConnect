# Add-Show Season Selection — Design Spec

**Date:** 2026-07-03
**Status:** Approved
**Author:** Zach + Claude

## Problem

The "Add Show" modal (TV Shows page) adds a whole series — every season
monitored and searched immediately (`ensureSeries(config.sonarr, tvdbId, null,
true)`). There's no way to add just *some* seasons, so you can't grab Season 1 to
try a show before committing to the rest.

## Goals

- When adding a show, let the user **pick which seasons** to monitor (a checkbox
  per season), so only the selected seasons get monitored and downloaded.
- Default to **all seasons checked**, so the current one-click "add whole show"
  still works.
- Reuse the existing shared season logic (`buildSeriesAddPayload`/`ensureSeries`)
  rather than a parallel add path.

## Non-Goals

- Per-episode selection (only per-season).
- Changing the Movies add flow, the auto-add-on-grab behavior (beyond the
  mechanical caller update), or the History/Downloads pages.
- Monitoring specials (season 0) — excluded from the picker (stays unmonitored).
- Editing seasons of an already-added show (this is the *add* flow only).

## Context (current state)

- **`server/src/services/arrAdd.ts`**:
  - `buildSeriesAddPayload(lookupSeries, qualityProfileId, rootFolderPath,
    season: number | null, languageProfileId?, search=false)` — builds the
    `seasons[]` monitoring: a single `season` → monitor only that one; `null`/no
    match → all monitored. `addOptions.searchForMissingEpisodes = search`.
  - `ensureSeries(base, tvdbId, season: number | null, search=false)` — lookup by
    tvdb → add with that season (or all).
- **Callers of `ensureSeries`** (both must be updated for the signature change):
  - `server/src/routes/sonarr.ts:17` (`/sonarr/add-series`): `ensureSeries(
    config.sonarr, tvdbId, null, true)` — the Add-Show endpoint.
  - `server/src/routes/nzbgeek.ts:124` (auto-add-on-grab): `ensureSeries(
    config.sonarr, tvdbId, typeof season === 'number' ? season : null)`.
- **`buildSeriesAddPayload` unit tests** (`arrAdd.test.ts`) pass a single season
  arg (`…, 1)`, `…, null)`, `…, 9)`) — must be updated to the new signature.
- **Client** `client/src/pages/TvShowsPage.tsx`: the Add-Show modal searches via
  `/sonarr/series/lookup?term=` (returns full series objects **including a
  `seasons` array**), renders results with an "Add" button, and `addSeries(r, i)`
  POSTs `{ tvdbId }` to `/sonarr/add-series`. The client `Series` type has
  `seasonCount` but not `seasons`.
- Sonarr's `series/lookup` result carries `seasons: [{ seasonNumber, monitored,
  … }]` — so the client already has the season list per result.
- Server tests are vitest (pure-function style). No client test harness.

## Architecture Overview

Generalize the single-season parameter to a **season set** through the existing
pipeline, then add a season picker to the modal.

1. **`buildSeriesAddPayload` / `ensureSeries`** — change `season: number | null`
   to `seasons: number[] | null` (pure payload builder stays unit-tested).
2. **Both callers updated** — `add-series` passes the user's selection; auto-add
   wraps its single season as `[season]` (behavior unchanged).
3. **Add-Show modal** — a checkbox-per-season picker feeding the selection.

## Component 1: `buildSeriesAddPayload` (season set)

New signature:
```ts
buildSeriesAddPayload(
  lookupSeries, qualityProfileId, rootFolderPath,
  seasons: number[] | null,   // null/empty → monitor ALL; else monitor exactly these
  languageProfileId?, search = false
): Dict
```
Behavior for the `seasons[]` mapping (over `lookupSeries.seasons`):
- `wantAll = !seasons || seasons.length === 0` → every season `monitored: true`
  (unchanged "add whole show" behavior; also the safety fallback).
- Else build `selected = new Set(seasons)`. **Safety:** if the selection matches
  **none** of the lookup's season numbers, fall back to all-monitored (never add
  a show with nothing monitored).
- Otherwise each lookup season → `monitored: selected.has(seasonNumber)`. Seasons
  not selected (including season 0 / specials, which the client never selects)
  are unmonitored.
- `addOptions.searchForMissingEpisodes = search` unchanged — Sonarr then searches
  only the **monitored** (selected) seasons, so only those download.

## Component 2: `ensureSeries` + the two callers

- `ensureSeries(base, tvdbId, seasons: number[] | null, search=false)` — pass
  `seasons` straight to `buildSeriesAddPayload`.
- **`sonarr.ts` `/add-series`:** accept `{ tvdbId, seasons?: number[] }`. Validate
  `tvdbId` (positive number) as today; if `seasons` is present it must be an array
  of numbers (else 400). Call `ensureSeries(config.sonarr, tvdbId, seasons ?? null,
  true)`. (Omitted `seasons` → `null` → all, so any existing callers stay valid.)
- **`nzbgeek.ts:124` (auto-add):** change to `ensureSeries(config.sonarr, tvdbId,
  typeof season === 'number' ? [season] : null)` — same behavior (monitor the
  grabbed season, or all).

## Component 3: Add-Show modal — season picker

- Add `seasons?: { seasonNumber: number; monitored?: boolean }[]` to the client
  `Series` interface (populated from the lookup).
- Per search result, render a **season checklist** from `r.seasons`, **excluding
  season 0** (specials). Each real season is a labeled checkbox ("S1", "S2", …),
  **all checked by default**. Track the checked set in component state keyed by
  result index (consistent with the existing `addState` map).
  - **Reset this checked-season state in `searchForShow()`** alongside the
    existing `addState`/`searchResults` resets — otherwise a stale selection from
    a prior search bleeds into the new results at the same index.
  - A compact "All / None" toggle is a nice-to-have; not required for v1.
- The **"Add" button is disabled when zero seasons are checked** (can't add a
  show monitoring nothing).
- `addSeries(r, i)` POSTs `{ tvdbId: r.tvdbId, seasons: <checked season numbers> }`
  to `/sonarr/add-series`. The existing Adding/Added/Already/Error feedback is
  unchanged (the "Added — searching" badge still applies; only the selected
  seasons are searched).
- If a lookup result has no `seasons` array (edge case), fall back to the current
  behavior: no checklist, Add posts `{ tvdbId }` only (→ server monitors all).

## Data Flow

Search → `/sonarr/series/lookup` (returns seasons) → modal shows a season checklist
per result (all checked) → user narrows to e.g. Season 1 → "Add" → POST
`/sonarr/add-series { tvdbId, seasons:[1] }` → `ensureSeries(…, [1], true)` →
`buildSeriesAddPayload` monitors only S1 → Sonarr adds the show, monitors S1, and
searches S1's episodes → only Season 1 downloads.

## Error Handling

| Case | Behavior |
|---|---|
| `seasons` omitted / empty | monitor all (safety fallback); client disables Add when none checked, so empty shouldn't reach the server. |
| Selection matches no lookup season | fall back to all-monitored (never add a fully-unmonitored show). |
| `seasons` not an array of numbers | `/add-series` → 400. |
| Lookup result has no `seasons` array | client omits the checklist; Add posts `{ tvdbId }` → server monitors all. |
| Add fails / already added | existing `ensureSeries` handling (already-added → `added:false`; other → error), surfaced by the existing badges. |

## Testing Strategy

- **`buildSeriesAddPayload` (pure, real logic):** update the existing tests to the
  `number[] | null` signature and add season-set cases:
  - `[1]` over lookup seasons `[0,1,2]` → only season 1 monitored, 0 and 2 not.
  - `[1,2]` → seasons 1 and 2 monitored, 0 not.
  - `null` and `[]` → all monitored (fallback).
  - selection `[9]` (no match) → all monitored (safety fallback).
  - `languageProfileId` and `search` flag still threaded correctly.
- **Callers compile:** `npm run build` after updating `sonarr.ts` and `nzbgeek.ts`
  (the auto-add call). The auto-add path's behavior is unchanged (covered by its
  own existing tests + the earlier live check).
- **Client:** `npm run build` (typecheck).
- **USER-RUN on the server PC:** in Add Show, search a multi-season show, uncheck
  down to **Season 1**, Add → confirm in Sonarr that only Season 1 is monitored
  and only Season 1 searches/downloads; then add a show with **all** seasons
  checked and confirm the whole show is monitored (no regression).

## Risks / Open Questions

- **`buildSeriesAddPayload` signature change touches the auto-add path.** Mitigated
  by updating the `nzbgeek.ts` caller to `[season]` (identical behavior) and the
  existing auto-add tests/live check. This is the only cross-feature coupling.
- **Sonarr `series/lookup` seasons shape** (`seasonNumber`/`monitored`) is stable
  in v3; the client guards for a missing `seasons` array. The live check confirms
  the monitoring actually takes on the real instance (arrs are localhost-only).
- **searchForMissingEpisodes on add** searches only monitored seasons — so
  narrowing to Season 1 both monitors and downloads only S1, matching the intent.

## Files Touched

**New:**
- `docs/superpowers/specs/2026-07-03-add-show-season-selection-design.md` (this).

**Modified:**
- `server/src/services/arrAdd.ts` — `buildSeriesAddPayload`/`ensureSeries` take
  `seasons: number[] | null`.
- `server/src/services/arrAdd.test.ts` — updated signature + season-set cases.
- `server/src/routes/sonarr.ts` — `/add-series` accepts `seasons?: number[]`.
- `server/src/routes/nzbgeek.ts` — auto-add call passes `[season]`.
- `client/src/pages/TvShowsPage.tsx` — `seasons` on the type; the season
  checklist; `addSeries` posts the selection; Add disabled when none checked.
