# Auto-Add on Grab — Design Spec

**Date:** 2026-07-02
**Status:** Approved
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
- `imdbId`: from the `imdb` attr via `formatImdbId(raw)`: `null` if empty; parse
  `parseInt(raw,10)` and return `null` if `NaN` (defensive — NZBGeek sends bare
  digits, but a `tt`-prefixed/garbage value must not yield `ttNaN`); else
  `'tt' + String(n).padStart(7,'0')` (handles NZBGeek's zero-padding and 7- and
  8-digit ids: `01375666`→`tt1375666`). `formatImdbId` is defined ONCE here in
  `newznab.ts`; `arrAdd` receives the already-formatted `imdbId`.
- `tvdbId`: `toInt(attr 'tvdbid')`.
- `season`: parse the `season` attr (`'S01'`/`'1'`) → `1`; `null` if absent/NaN.
- `episode`: parse the `episode` attr (`'E01'`/`'1'`) → `1`; `null` if absent.

`formatImdbId` and the season/episode parsing are pure helpers with unit tests
(incl. the real fixture: movie items yield a `tt…` id, and the earlier probe
confirms TV items yield `tvdbId`/`season`/`episode`).

## Component 2: `server/src/services/arrAdd.ts`

**`imdbId` arrives already formatted** (`tt#######`) from the parser
(`formatImdbId` lives in `newznab.ts`, one definition — `arrAdd` does not
re-implement it; the route passes the parser's `imdbId` straight through).

**Pure, unit-tested helpers:**
- `buildMovieAddPayload(lookupMovie, qualityProfileId, rootFolderPath)` → returns
  `{ ...lookupMovie, qualityProfileId, rootFolderPath, monitored:true,
  minimumAvailability:'released', addOptions:{ searchForMovie:false } }`.
  **Override invariant:** spread `lookupMovie` FIRST, then the enrichment fields,
  so our values win over any `monitored`/`addOptions`/`minimumAvailability` the
  lookup object already carries.
- `buildSeriesAddPayload(lookupSeries, qualityProfileId, rootFolderPath, season,
  languageProfileId?)` → `{ ...lookupSeries, qualityProfileId, rootFolderPath,
  monitored:true, addOptions:{ searchForMissingEpisodes:false }, seasons:<mapped>
  }` plus `languageProfileId` **only if provided** (spread lookup first, then
  enrichment). `seasons` mapping: start from `lookupSeries.seasons`; if `season`
  is a number AND some entry has `seasonNumber === season`, set that entry
  `monitored:true` and the rest `monitored:false`; **otherwise (season null or no
  match) set ALL entries `monitored:true`** as a fallback so the pushed episode
  is monitored and imports rather than silently monitoring nothing. (Season packs
  arrive as `episode: 0` / `E00` — the season-level monitoring covers them.)
- default pickers (trivial: `list[0]?.id` / `list[0]?.path`).

**Thin orchestrators (integration — call the arr; not unit-tested, exercised in
the live test):** each takes an arr base `{ url, apiKey }` (from `config`) and
returns `{ added: boolean }` or throws a descriptive `Error`. Idempotency uses
the **duplicate-add error path** rather than a pre-fetch, because Radarr's
`GET /movie?tmdbId=` filter is not reliable across versions (if ignored it
returns the whole library → every title would read as already-present and
NOTHING would get added — inverting the feature).
- `ensureMovie(base, imdbId)`:
  1. `GET {url}/api/v3/movie/lookup?term=imdb:{imdbId}` → `movie = [0]`; if none,
     throw `"Movie not found for {imdbId}"`.
  2. Fetch defaults (`qualityprofile[0].id`, `rootfolder[0].path`; throw a clear
     error if either list is empty).
  3. `POST /api/v3/movie` with `buildMovieAddPayload(...)`. On 2xx → `{added:true}`.
     On a 400 whose body signals the movie already exists (Radarr's
     `MovieExistsValidator` / "already been added") → `{added:false}`. Any other
     non-2xx → throw with the arr's error message.
- `ensureSeries(base, tvdbId, season)`: same shape —
  1. `GET {url}/api/v3/series/lookup?term=tvdb:{tvdbId}` → `series = [0]`; throw
     if none.
  2. Defaults + optional `languageProfileId` (`GET /languageprofile` → `[0].id`
     if the endpoint exists / returns a non-empty list; omit on 404/empty → v4).
  3. `POST /api/v3/series` with `buildSeriesAddPayload(...)`. On 2xx →
     `{added:true}`. On an "already exists" 400 → `{added:false}`. Else throw.

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
4. Respond `{ added: <bool>, push: <scrubbedPushBody> }` with the push's status
   code. **Nest** the push body under `push` — do NOT spread it. `release/push`
   can return an **array** of decisions; spreading an array into an object
   literal yields `{ added, '0': {…} }`, which would break the client's
   `Array.isArray(data) ? data[0] : data` logic and silently misread every push
   as "Grabbed". Nesting keeps the push body intact for the unchanged
   `interpretPush`. (If ensure fails at step 2, the route returns its error
   status/body and never reaches here.)

## Component 4: SearchPage — send IDs, richer feedback

- Client `NzbResult` gains `imdbId`/`tvdbId`/`season`/`episode` (mirror server).
- `grabToArr` includes them: `api.post('/nzbgeek/send-to-arr', { title, nzbUrl:
  r.link, pubDate, target, imdbId: r.imdbId, tvdbId: r.tvdbId, season: r.season,
  episode: r.episode })`.
- **Reading the new envelope:** on success (2xx), `res.data` is `{ added, push }`.
  Pass `res.data.push` (NOT `res.data`) into the **unchanged** `interpretPush`,
  and read `res.data.added` from the top level. If the outcome is `grabbed` and
  `added === true` → **"Added + Grabbed"**; grabbed and not added → **"Grabbed"**.
  Rejected/Error unchanged (a rejected push with `added:true` still shows
  "Rejected" — the add happened but the release was declined, which is the useful
  message). On a thrown non-2xx (ensure failed / arr unreachable), the catch
  passes the error body to `interpretPush` → **"Error"** (the added state is not
  surfaced in the error case; acceptable).

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
| Already in library (add returns "already exists" 400) | `ensure` returns `added:false`; proceed to push → row "Grabbed". |
| Add fails (other non-2xx) | `ensure` throws → route error; row "Error" with the arr's message. |
| TV: grabbed season not in lookup `seasons[]` | Fallback: all seasons monitored (so the pushed episode imports). |
| Push rejected after a successful add | Row "Rejected: <reason>" (add happened; release declined). Rare once monitored. |
| Sonarr v3 vs v4 `languageProfileId` | Included only when `languageprofile` exists; otherwise omitted. Verified in the live test. |

## Testing Strategy

- **Parser:** vitest — `formatImdbId` (zero-pad → `tt…`, empty/NaN → null),
  season/episode parsing (`S01`→1, `E00`→0, missing→null), against **both real
  fixtures**: the movies fixture (`nzbgeek-search.json`; items yield `tt…`
  imdbId — real values `00133093`→`tt0133093`, `00242653`→`tt0242653`) AND the
  new **real TV fixture** (`nzbgeek-search-tv.json`; items yield `tvdbId`
  `361753`, `season` 1, `episode` including a season-pack `0`). Both are captured
  from the live API with keys redacted.
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
  and 8-digit ids (with a `NaN`→null guard). If a lookup-by-imdb ever misses, a
  fallback to `movie/lookup?term=<release title>` is a possible later addition.
- **TV episode monitoring is the #1 live-test check.** We monitor the grabbed
  season (or all seasons if we can't match it) with `searchForMissingEpisodes:
  false`. The open question the live test answers: does the pushed episode
  actually import given that monitoring, or does Sonarr reject it as unmonitored?
  If rejected, the fix is to also set `addOptions.monitor` or monitor the exact
  episode post-add — deferred until the live test shows it's needed.
- **Idempotency via the add-error path**, not a pre-fetch: we attempt the add and
  treat Radarr's/Sonarr's "already exists" 400 as `added:false`. This avoids
  relying on `GET /movie?tmdbId=` filtering (unreliable across versions — if the
  filter were ignored it would return the whole library and nothing would ever be
  added).

## Files Touched

**New:**
- `server/src/services/arrAdd.ts` — add-payload builders, default pickers,
  `ensureMovie`/`ensureSeries`. (`formatImdbId` lives in `newznab.ts`.)
- `server/src/services/arrAdd.test.ts` — pure-helper unit tests (payload
  builders, season-monitoring incl. the no-match fallback).
- `server/src/services/__fixtures__/nzbgeek-search-tv.json` — real captured TV
  `extended=1` response (keys redacted); **already created and committed by the
  controller** (contains a live key in the raw capture, so redacted out-of-band).
- `docs/superpowers/specs/2026-07-02-auto-add-on-grab-design.md` (this file).

**Modified:**
- `server/src/services/newznab.ts` — extract `imdbId`/`tvdbId`/`season`/
  `episode`; `newznab.test.ts` gains cases.
- `server/src/routes/nzbgeek.ts` — `/send-to-arr` ensures-then-pushes, returns
  `added`.
- `client/src/pages/SearchPage.tsx` — send the IDs; "Added + Grabbed" feedback.
