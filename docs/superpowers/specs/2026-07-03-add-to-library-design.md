# Add to Library (wire up Add Show / Add Movie) — Design Spec

**Date:** 2026-07-03
**Status:** Approved
**Author:** Zach + Claude

## Problem

The Movies and TV Shows pages each have an "Add Movie" / "Add Show" modal that
searches Radarr/Sonarr's metadata lookup (`/radarr/movie/lookup`,
`/sonarr/series/lookup`) and renders the results. But the result rows have **no
click handler and no Add button** — clicking a result does nothing. The user
cannot actually add a title to the library from the dashboard.

The desired flow is one click: **click a search result → add to Radarr/Sonarr
(monitored) → the arr searches NZBGeek → grabs the NZB → SAB downloads → import
→ Plex refresh** — with no further prompts.

The download/import/Plex pipeline is **native to Radarr/Sonarr**: adding with
`addOptions.searchForMovie: true` / `searchForMissingEpisodes: true` makes the
arr drive the entire search-grab-import chain itself. We do not touch NZBGeek or
SAB directly for this flow.

## Goals

- Make search results in both Add modals clickable: an **Add** action per row
  that adds the title to the library and kicks off the download.
- Add **monitored + auto-search** (the user's chosen behavior):
  - Movie → monitored, `searchForMovie: true`.
  - TV → whole series monitored, `searchForMissingEpisodes: true` (searches all
    missing episodes immediately).
- Auto-select the **first** quality profile + **first** root folder from each arr
  (same zero-config default as the existing `send-to-arr` auto-add).
- Reuse the existing `arrAdd` service (`build*AddPayload`, `fetchDefaults`,
  `ensureMovie`/`ensureSeries`) — the auto-add-on-grab spec explicitly left this
  service reusable for exactly this feature.
- Clear per-row feedback: **Adding… / Added — searching / Already in library /
  Error**.
- Cover **both** Radarr (movies) and Sonarr (TV).

## Non-Goals

- A UI to choose quality profile / root folder / monitoring per add. First-of-each
  default only (configurable defaults are a possible later add).
- A TV season-picker. The user chose "auto-search all"; whole series is
  monitored and all missing episodes are searched at add time.
- Changing the existing `/send-to-arr` (release-push) flow's behavior — its
  auto-add must remain **no-search** (`search` defaults to `false`).
- Deduping / advanced "already added" reconciliation beyond the existing
  `looksAlreadyAdded` signature detection.

## Design

### Server — extend `arrAdd.ts` (add a `search` flag, default `false`)

The existing builders hardcode `addOptions.searchForMovie: false` /
`searchForMissingEpisodes: false`. Add an optional `search` parameter, defaulting
to `false` so the existing `send-to-arr` caller is byte-for-byte unchanged:

- `buildMovieAddPayload(lookupMovie, qualityProfileId, rootFolderPath, search = false)`
  → sets `addOptions: { searchForMovie: search }`.
- `buildSeriesAddPayload(lookupSeries, qualityProfileId, rootFolderPath, season, languageProfileId?, search = false)`
  → sets `addOptions: { searchForMissingEpisodes: search }`.
- `ensureMovie` / `ensureSeries` gain a trailing `search = false` param passed
  through to the builder.

**Movie identity:** Radarr lookups reliably carry `tmdbId`, not always `imdbId`.
Generalize the internal movie lookup to accept a term of either `tmdb:<id>` or
`imdb:<id>`, preferring tmdb. `ensureMovie` accepts an id descriptor
`{ tmdbId?, imdbId? }` (or two optional params) and builds the term, erroring if
neither is present. The existing `send-to-arr` caller (which passes `imdbId`)
continues to work via the imdb branch.

### Server — new routes (matched before the catch-all proxy)

Both `sonarr.ts` and `radarr.ts` are catch-all proxies (`router.all('/*path')`).
Register the specific POST routes **before** that line so Express matches them
first; anything else still falls through to the proxy.

- `POST /sonarr/add-series` — body `{ tvdbId }` →
  `ensureSeries(config.sonarr, tvdbId, null, /* search */ true)` → `{ added }`.
- `POST /radarr/add-movie` — body `{ tmdbId, imdbId }` →
  `ensureMovie(config.radarr, { tmdbId, imdbId }, /* search */ true)` → `{ added }`.

Validation mirrors `send-to-arr`: reject missing/ill-typed ids with `400`;
surface arr/network failures as `502` with a short message. `added: false` (the
`looksAlreadyAdded` case) is a **success** response, not an error.

### Client

- **`TvShowsPage`**: add `tvdbId: number` to the lookup result type. Give each
  `search-result-item` an **Add** button (or make the row clickable) with per-row
  state keyed by result index: `idle → adding → added / already / error`. On
  click → `POST /sonarr/add-series` with `{ tvdbId }`. On `added: true` show
  "Added — searching" and refresh the series list (`fetchSeries`); on
  `added: false` show "Already in library"; on failure show a short error.
- **`MoviesPage`**: same pattern keyed on `tmdbId` (with `imdbId` fallback);
  add `tmdbId`/`imdbId` to the lookup result type; `POST /radarr/add-movie`;
  refresh via `fetchMovies` on success.

Follow the existing per-row feedback idiom from `SearchPage` (a small state map
keyed by row, badge classes `badge-success` / `badge-warning` / `badge-danger`).

## Error Handling

- Missing/invalid id → `400` from the route; client shows "Error".
- Arr unreachable / add rejected → `502` with message; client shows a short
  inline error, modal stays open so the user can retry.
- Duplicate add → `ensure*` returns `{ added: false }` (via `looksAlreadyAdded`)
  → client shows "Already in library" (not an error).

## Testing

- **Unit:** `buildMovieAddPayload` / `buildSeriesAddPayload` with `search: true`
  and `search: false` — assert the correct `addOptions` key/value and that other
  fields (monitored, quality profile, root folder, season monitoring) are
  unchanged. Pure functions, no network.
- **Live (server PC only):** the arrs are localhost-only, so a real add + grab
  must be run on the server PC. Verify: add a movie and a show, confirm each
  appears monitored in Radarr/Sonarr, a search fires, SAB receives the download,
  and it imports through to Plex. This step is flagged for the user to run — not
  assumed complete from the dev PC.

## Reuse / Impact

- Reuses `arrAdd.ts` (builders, `fetchDefaults`, `ensure*`) — the mechanism the
  auto-add-on-grab spec anticipated for this feature.
- The `search` flag defaults to `false`, so `POST /nzbgeek/send-to-arr` behavior
  is unchanged.
- No new dependencies; no `.env` changes.
