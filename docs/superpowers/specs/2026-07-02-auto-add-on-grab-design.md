# Auto-Add on Grab — Design Spec

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
**Author:** Zach + Claude

## Problem

The Search page now routes a grab through Sonarr/Radarr via `release/push`
(shipped in the search-enhancements feature). But `release/push` only succeeds
for content **already added** to the library — grabbing a movie/show that isn't
tracked yet returns "Rejected: Unknown Movie/Series. Unable to match to existing
… using release title." The user wants the flow to be seamless:
**search → grab → (auto-add to Sonarr/Radarr) → download via SAB → import →
Plex**, without having to pre-add the title. This is the auto-add enhancement
that the search feature deliberately deferred.

## Goals

- On grab, if the movie/show isn't in Radarr/Sonarr yet, **add it automatically**
  (monitored) and then push the release — one click, no prompts.
- Identify the title **reliably by ID**, not by parsing the release name:
  movies by IMDb id, TV by TVDB id (both present in NZBGeek `extended=1` results).
- Auto-select the (single) quality profile + root folder from each arr — zero
  config for the typical one-of-each setup.
- Clear per-row feedback: **Added + Grabbed** / **Grabbed** / **Rejected** /
  **Error**.
- Cover **both** Radarr (movies) and Sonarr (TV) in this change.

## Non-Goals

- A UI to choose quality profile / root folder / monitoring per grab. We
  auto-pick the first of each. (Configurable defaults are a possible later add.)
- Multi-profile / multi-root-folder selection logic beyond "use the first".
- Backfilling the incomplete "Add Movie/Show" modals on the Movies/TV pages
  (they currently only look up, never add) — out of scope, though this feature's
  server `arr-add` service could be reused there later.
- Season-pack vs single-episode nuance beyond "monitor the grabbed episode's
  season". We do not try to monitor the whole series or only the single episode.

## Real Findings (verified live, 2026-07-02)

- **NZBGeek `extended=1` results carry the IDs we need** (confirmed against the
  live API): movie results (cat 2xxx) have an `imdb` attr (e.g. Inception →
  `01375666`); TV results (cat 5xxx) have `tvdbid` (e.g. Mandalorian → `361753`)
  plus `season` (`S01`) and `episode` (`E01`). So identification is by ID, not
  fragile title parsing.
  - NZBGeek zero-pads the imdb value; normalize to the `tt#######` form Radarr
    expects: `tt` + `parseInt(raw,10)` zero-padded to at least 7 digits
    (`01375666` → `tt1375666`).
- **Arr add API** (from Radarr/Sonarr v3/v4 docs; the definitive check is the
  user's running instance — arrs are `localhost`-only, unreachable from the dev
  PC, so the live add→import flow is a user-run test):
  - Radarr: `GET /api/v3/movie/lookup?term=imdb:tt<id>` → array; first item is
    the movie object (with `tmdbId`, `title`, `titleSlug`, `images`, …). Add via
    `POST /api/v3/movie` with that object **enriched** with `qualityProfileId`,
    `rootFolderPath`, `monitored:true`, `minimumAvailability:'released'`,
    `addOptions:{ searchForMovie:false }`.
  - Sonarr: `GET /api/v3/series/lookup?term=tvdb:<id>` → array; first item is the
    series object (with `seasons`, `title`, `titleSlug`, `images`, …). Add via
    `POST /api/v3/series` enriched with `qualityProfileId`, `rootFolderPath`,
    `monitored:true`, `seasons` (the grabbed season monitored, others as-is),
    `addOptions:{ searchForMissingEpisodes:false }`. **`languageProfileId` is
    required on Sonarr v3 but removed on v4** — include it only if the instance
    exposes `GET /api/v3/languageprofile` (see Component 3).
  - Defaults: `GET /api/v3/qualityprofile` → `[0].id`; `GET /api/v3/rootfolder`
    → `[0].path`.

## Context (current state)

- `server/src/routes/nzbgeek.ts` `POST /send-to-arr` currently takes
  `{ title, nzbUrl, pubDate, target }` and does exactly one thing: `release/push`.
  It scrubs `apikey=` from the arr's echoed body. This is what we extend.
- `server/src/services/newznab.ts` `parseNewznabResults` emits
  `{ guid, title, link, category, categoryId, sizeBytes, pubDate, grabs }` — no
  IDs yet. The raw NZBGeek items DO carry `imdb`/`tvdbid`/`season`/`episode`
  attrs (with `extended=1`, which the `/search` route already sends).
- `client/src/pages/SearchPage.tsx` sends `{ title, nzbUrl: r.link, pubDate,
  target }` and interprets the push decision. The Movies/TV "Add" modals only
  look up, never add — so there is no existing add-to-arr code to reuse.
- Arr calls go directly (plain `fetch` with `X-Api-Key`) in `send-to-arr`, or via
  the generic `proxyRequest` for the `/sonarr`/`/radarr` passthrough routes.
- Server tests are vitest, pure-function style.

## Architecture Overview

Three units with clean boundaries:

1. **Parser (extend `newznab.ts`):** extract `imdbId` (formatted), `tvdbId`,
   `season`, `episode` into `NzbResult`. Pure; unit-tested against the real
   fixture + synthetic cases.
2. **`arr-add` service (new `server/src/services/arrAdd.ts`):** the library-add
   logic. Pure, unit-tested helpers (imdb formatting, add-payload builders,
   default pickers) + thin `ensureMovie` / `ensureSeries` orchestrators that call
   the arr (lookup → check-exists → add). Knows nothing about HTTP routing or the
   client.
3. **`/send-to-arr` (extend the route):** orchestrate **ensure-in-library →
   push**, and report `added` alongside the (scrubbed) push decision.
4. **Client:** send the IDs with the grab; render "Added + Grabbed" vs "Grabbed"
   vs "Rejected"/"Error".

The client sends IDs; the route owns the ensure→push sequence; `arrAdd` owns the
arr add semantics; the parser owns extraction. Each is independently testable.

## Component 1: Parser — extract IDs (`newznab.ts`)

Add to `NzbResult`:
```ts
imdbId: string | null;   // 'tt#######' (movies), else null
tvdbId: number | null;   // TV series id, else null
season: number | null;   // grabbed season number (from 'S01'), else null
episode: number | null;  // grabbed episode number (from 'E01'), else null
```
Extraction (all optional/defensive):
- `imdbId`: from the `imdb` attr via `formatImdbId(raw)` = `null` if empty, else
  `'tt' + String(parseInt(raw,10)).padStart(7,'0')`.
- `tvdbId`: `toInt(attr 'tvdbid')`.
- `season`: parse the `season` attr (`'S01'`/`'1'`) → `1`; `null` if absent/NaN.
- `episode`: parse the `episode` attr (`'E01'`/`'1'`) → `1`; `null` if absent.

`formatImdbId` and the season/episode parsing are pure helpers with unit tests
(incl. the real fixture: movie items yield a `tt…` id, and the earlier probe
confirms TV items yield `tvdbId`/`season`/`episode`).

## Component 2: `server/src/services/arrAdd.ts`

**Pure, unit-tested helpers:**
- `formatImdbId(raw: string): string | null` (as above; shared with the parser
  or re-exported — one definition).
- `buildMovieAddPayload(lookupMovie, qualityProfileId, rootFolderPath)` → the
  lookup object spread with `qualityProfileId`, `rootFolderPath`,
  `monitored:true`, `minimumAvailability:'released'`,
  `addOptions:{ searchForMovie:false }`.
- `buildSeriesAddPayload(lookupSeries, qualityProfileId, rootFolderPath, season,
  languageProfileId?)` → the lookup object spread with `qualityProfileId`,
  `rootFolderPath`, `monitored:true`, `addOptions:{ searchForMissingEpisodes:
  false }`, `languageProfileId` (only if provided), and `seasons` mapped so the
  entry whose `seasonNumber === season` has `monitored:true` (others left as the
  lookup returned them; if `season` is null, leave seasons untouched).
- `firstIdOrPath` type pickers (trivial: `list[0]?.id` / `list[0]?.path`).

**Thin orchestrators (integration — call the arr; not unit-tested, exercised in
the live test):** each takes an arr base `{ url, apiKey }` (from `config`) and
returns `{ added: boolean }` or throws a descriptive `Error`.
- `ensureMovie(base, imdbId)`:
  1. `GET {url}/api/v3/movie/lookup?term=imdb:{imdbId}` → `movie = [0]`; if none,
     throw `"Movie not found for {imdbId}"`.
  2. Already present? `GET {url}/api/v3/movie?tmdbId={movie.tmdbId}` → if the
     array is non-empty, return `{ added:false }`.
  3. Else fetch defaults (`qualityprofile[0].id`, `rootfolder[0].path`; throw a
     clear error if either list is empty), `POST /api/v3/movie` with
     `buildMovieAddPayload(...)`. Return `{ added:true }`. A "already exists"
     add error is treated as `{ added:false }`, not a failure.
- `ensureSeries(base, tvdbId, season)`:
  1. `GET {url}/api/v3/series/lookup?term=tvdb:{tvdbId}` → `series = [0]`; throw
     if none.
  2. Already present? `GET {url}/api/v3/series` → if any has `tvdbId === tvdbId`,
     return `{ added:false }`.
  3. Else defaults + optional `languageProfileId` (`GET /languageprofile` → `[0]
     .id` if the endpoint exists / returns a non-empty list; omit on 404/empty →
     v4), `POST /api/v3/series` with `buildSeriesAddPayload(...)`. Return
     `{ added:true }`.

## Component 3: `/send-to-arr` — ensure then push

Extend the body to `{ title, nzbUrl, pubDate, target, imdbId, tvdbId, season,
episode }` (all the new fields optional). Flow:
1. Validate as today (string `title`/`nzbUrl`, `target ∈ {sonarr,radarr}` → 400).
2. **Ensure in library** (idempotent):
   - `radarr` + `imdbId` → `ensureMovie(config.radarr, imdbId)`.
   - `sonarr` + `tvdbId` → `ensureSeries(config.sonarr, tvdbId, season)`.
   - Missing id → skip ensure (fall back to push-only; may reject, same as today).
   - If ensure throws → respond `502`/`400` with the error message; **do not
     push** (nothing to import into). Surfaced to the row as "Error".
3. **Push** the release via `release/push` exactly as today (key appended
   server-side; response scrubbed of `apikey=`).
4. Respond with `{ added: <bool>, ...scrubbedPushBody }` and the push status, so
   the client can distinguish "added" from "already there".

## Component 4: SearchPage — send IDs, richer feedback

- Client `NzbResult` gains `imdbId`/`tvdbId`/`season`/`episode` (mirror server).
- `grabToArr` includes them: `api.post('/nzbgeek/send-to-arr', { title, nzbUrl:
  r.link, pubDate, target, imdbId: r.imdbId, tvdbId: r.tvdbId, season: r.season,
  episode: r.episode })`.
- `interpretPush` (or a thin wrapper) also reads the top-level `added` flag: on a
  grabbed outcome, if `added === true` show **"Added + Grabbed"**, else
  **"Grabbed"**. Rejected/Error unchanged. (The `added` flag lives alongside the
  push decision fields; a rejected push with `added:true` still shows "Rejected"
  — the add happened but the release was declined, which is worth the rejection
  message.)

## Data Flow

Grab (arr) → `POST /send-to-arr {title,nzbUrl,pubDate,target,imdbId|tvdbId,
season,episode}` → server `ensureMovie`/`ensureSeries` (lookup by id → add if
missing, monitored, grabbed season for TV) → `release/push` → `{added, decision}`
(key-scrubbed) → client shows Added+Grabbed / Grabbed / Rejected / Error. On
approval the arr grabs via SAB (correct category) → CDH → import → Plex refresh.

## Error Handling

| Case | Behavior |
|---|---|
| Movie/series id missing on the result | Skip ensure; push-only (may reject "unknown"). |
| Lookup returns nothing for the id | `ensure` throws → route 502 → row "Error: not found". |
| No quality profile / root folder configured | `ensure` throws a clear error → row "Error". |
| Already in library | `ensure` returns `added:false`; proceed to push. |
| Add fails ("already exists") | Treated as `added:false`; proceed to push. |
| Add fails (other) | Route error; row "Error" with the arr's message. |
| Push rejected after a successful add | Row "Rejected: <reason>" (add happened; release declined). Rare once monitored. |
| Sonarr v3 vs v4 `languageProfileId` | Included only when `languageprofile` exists; otherwise omitted. Verified in the live test. |

## Testing Strategy

- **Parser:** vitest — `formatImdbId` (zero-pad → `tt…`, empty → null), season/
  episode parsing (`S01`→1, missing→null), and the real fixture (movie items get
  a `tt…` imdbId; assert shape).
- **`arrAdd` pure helpers:** vitest — `buildMovieAddPayload`/
  `buildSeriesAddPayload` produce the enriched objects (correct monitored season,
  addOptions, languageProfileId present/absent), given synthetic lookup objects.
- **`ensureMovie`/`ensureSeries` + `/send-to-arr` live path:** unverifiable from
  the dev PC (arrs are `localhost`-only). **USER-RUN on the server PC:** grab a
  movie and a show **not** in the library → confirm each ends **Added + Grabbed**,
  the item appears in Radarr/Sonarr (monitored; the grabbed season monitored for
  TV), downloads via SAB, imports, and Plex refreshes. Grab something already in
  the library → **Grabbed** (added:false). If an add errors, report the arr's
  message (likely `languageProfileId` on v3, `minimumAvailability`, or a
  root-folder/profile issue) → adjust and re-test.
- **Client:** `npm run build` (typecheck) + the live test.

## Risks / Open Questions

- **Arr add API unverified from the dev PC** (Sonarr `languageProfileId` version
  split; Radarr `minimumAvailability`; exact lookup response fields). Mitigated by
  enriching the real lookup object (carries required fields), conditionally
  including `languageProfileId`, and passing arr errors through to the UI. The
  live test confirms.
- **Monitored side effect (accepted):** grabbed items become monitored library
  entries; Radarr/Sonarr may later upgrade-search per the profile cutoff. This is
  the intended "it's in my library now" behavior. `searchForMovie:false` /
  `searchForMissingEpisodes:false` prevent an immediate extra search on add.
- **imdb formatting:** NZBGeek zero-pads; `tt`+`parseInt`.padStart(7) handles 7-
  and 8-digit ids. If a lookup-by-imdb ever misses, a fallback to
  `movie/lookup?term=<release title>` is a possible later addition (not now).
- **"Already present" checks** use `GET /movie?tmdbId=` (Radarr filters) and
  `GET /series` scan (Sonarr). Fine for a home library; the duplicate-add error
  path is also handled as `added:false` as a backstop.

## Files Touched

**New:**
- `server/src/services/arrAdd.ts` — imdb formatting, add-payload builders,
  default pickers, `ensureMovie`/`ensureSeries`.
- `server/src/services/arrAdd.test.ts` — pure-helper unit tests.
- `docs/superpowers/specs/2026-07-02-auto-add-on-grab-design.md` (this file).

**Modified:**
- `server/src/services/newznab.ts` — extract `imdbId`/`tvdbId`/`season`/
  `episode`; `newznab.test.ts` gains cases.
- `server/src/routes/nzbgeek.ts` — `/send-to-arr` ensures-then-pushes, returns
  `added`.
- `client/src/pages/SearchPage.tsx` — send the IDs; "Added + Grabbed" feedback.
