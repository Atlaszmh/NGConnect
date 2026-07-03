# Search Enhancements — Design Spec

**Date:** 2026-07-02
**Status:** Approved
**Author:** Zach + Claude

## Problem

The manual search page ([client/src/pages/SearchPage.tsx](../../../client/src/pages/SearchPage.tsx))
queries NZBGeek via the Newznab API and shows only **Name, Category, Size,
Age**. When multiple releases match (e.g. a dozen versions of the same movie at
different sizes/qualities), there's not enough information to pick the best one,
and the columns aren't sortable. The most useful signal for "which release is
good" — **grabs** (how many people downloaded it) — and **files** count are
already present in the API response but are discarded.

## Goals

- Show, per result: **Name, Category, Age, Size, Files, Grabs**.
- Make **every** column sortable (click header to sort; click again to reverse).
- Surface data that's already in the Newznab response but currently ignored
  (grabs, files, accurate date), so the user can rank releases themselves.

## Non-Goals

- Adding social signals from the NZBGeek *website* (comment counts, thumbs
  up/down). Those are not part of the Newznab search API and would be blank.
- Server-side / indexer-side sorting or paging. Sorting is done client-side on
  the fetched result set.
- Changing how downloads are sent to SABnzbd (the existing "Send to SABnzbd"
  action is preserved as-is).
- Saved searches, filters, or multi-indexer support.

## Context (current state)

- **Client** [SearchPage.tsx](../../../client/src/pages/SearchPage.tsx): calls
  `GET /api/nzbgeek/search?q=&cat=`, then reads
  `res.data?.channel?.item || res.data?.item` and renders a table. It already
  has `formatSize` and `formatAge` helpers. The `NzbResult` type declares an
  `attr?: {name,value}[]` array but never reads it.
- **Server** [nzbgeek.ts](../../../server/src/routes/nzbgeek.ts): the `/search`
  route proxies to `${nzbgeek.baseUrl}/api?t=search&o=json&...` and returns the
  **raw Newznab JSON** verbatim. `limit` defaults to `'50'`.
- **Confirmed:** `/api/nzbgeek/search` is consumed **only** by SearchPage
  (verified by grep across `client/`), so changing its response shape is safe.
  The `send-to-sab` POST takes `{ title, nzbUrl }` where `nzbUrl` is the result's
  `link` — the normalized shape preserves `link`, so that path is unaffected.
- **Newznab response quirks** the parser must absorb (the `@attributes` nesting
  is the standard XML→JSON convention and is **confirmed in this repo**: the
  existing SearchPage already reads `enclosure?.['@attributes']?.length`):
  - Results live at `channel.item` (sometimes just `item`); a single result may
    be an object rather than a one-element array.
  - Extended fields come as `newznab:attr` → JSON `attr`, an array whose each
    element is `{ "@attributes": { "name": "...", "value": "..." } }` (name and
    value are **nested under `@attributes`**, not flat). For a single attr, `attr`
    may be a lone such object instead of an array.
  - `enclosure` is likewise `{ "@attributes": { url, length, type } }`; size is
    `enclosure["@attributes"].length`, or an attr named `size`, or a top-level
    `size`.
  - `guid` is often `{ "@attributes": { isPermaLink }, "text": "<id>" }` (or a
    plain string on some indexers) — not guaranteed to be a bare string.
  - `grabs`, `files`, `usenetdate` are standard Newznab attrs but any of them
    can be absent for a given result/indexer.
  - **Fixtures for the parser tests MUST be captured from a real NZBGeek
    `o=json` response** (API key redacted), not hand-invented — this shape was
    the one place the original design guessed wrong, so the tests must be
    grounded in reality (see Testing Strategy).
- **Testing convention:** the server unit-tests pure functions with vitest
  (`parseVpnStatus`, `readDeployStatus`, `classifyTriggerResult`). This feature
  follows that pattern.

## Architecture Overview

Normalize the messy Newznab response **on the server** into a clean, typed
array; the client renders and sorts that array. Two small units:

1. **`parseNewznabResults(raw)`** — a pure function (new
   `server/src/services/newznab.ts`) that turns the raw Newznab JSON into
   `NzbResult[]`. All the quirk-handling lives here and is unit-tested.
2. **SearchPage table + client-side sort** — consumes the clean array, renders
   the six columns, and sorts the in-memory result set on header click.

The two communicate through one well-defined interface: the `NzbResult[]` JSON
the `/search` route returns. The React component knows nothing about Newznab
attrs; the parser knows nothing about the UI.

**Why server-side normalization:** it centralizes the fragile Newznab parsing in
one testable pure function (matching the repo's test style), keeps the component
simple, and means the client type is clean. Parsing in the component would put
untested, fragile logic in the UI (there is no client test framework).

**Why client-side sort:** the fetched set (≤100 rows) sorts instantly in the
browser, uniformly across all columns, with no re-fetch; Newznab's own sort
support is limited and inconsistent across fields.

## Component 1: `server/src/services/newznab.ts`

Exports the result type and the parser.

```ts
export interface NzbResult {
  guid: string;
  title: string;
  link: string;          // NZB URL used by send-to-sab
  category: string;      // raw category text/code, best-effort
  sizeBytes: number;     // 0 if unknown
  pubDate: string;       // ISO date string; '' if unknown
  files: number | null;  // null if the indexer didn't report it
  grabs: number | null;  // null if the indexer didn't report it
}

export function parseNewznabResults(raw: unknown): NzbResult[];
```

**Behavior:**
- Locate the items array from `raw.channel.item` or `raw.item`; if it's a single
  object, wrap it in an array; if absent/not-an-object, return `[]`.
- **`attrMap(item)` helper** → `Map<string,string>` keyed by attr name: iterate
  `item.attr` (normalize a lone object to a one-element array), and for each
  element read the name/value from `el["@attributes"]` (the confirmed nested
  shape). As cheap insurance against indexer variation, also fall back to a flat
  `el.name`/`el.value` if `@attributes` is absent. Keys: `grabs`, `files`,
  `usenetdate`, `size`, `category`, …
- **`asString(x)` / guid helper**: `guid` may be a string OR an object like
  `{ "@attributes": {...}, "text": "<id>" }`. Extract the string form: if
  `item.guid` is a string use it; else use `item.guid.text` (or
  `item.guid["#text"]`); else fall back to `link`. The result MUST be a usable
  string (used as the React `key` and in send-to-sab).
- Field extraction (all defensive; bad/missing → the documented default):
  - `guid`: per the guid helper above; fall back to `link`.
  - `title`: `item.title` → `''`.
  - `link`: `item.link` → `''` (reuse the same `asString` helper as `guid`, in
    case it's an object).
  - `category`: attr `category` → `item.category` → `''`.
  - `sizeBytes`: `enclosure["@attributes"].length` → attr `size` →
    `item.size`, parsed as an integer; non-numeric → `0`.
  - `pubDate`: attr `usenetdate` → `item.pubDate`; kept as the original string
    (the client parses it). `''` if absent.
  - `files`: attr `files` parsed as int; missing/non-numeric → `null`.
  - `grabs`: attr `grabs` parsed as int; missing/non-numeric → `null`.
- **Never throws.** Any structural surprise yields `[]` or per-field defaults.
- Items without a usable `guid` **and** `link` are skipped (can't be actioned).

**Unit tests** (`server/src/services/newznab.test.ts`). **The primary fixture
MUST be a real captured NZBGeek `o=json` response** (see Testing Strategy) so the
`@attributes` shape is validated against reality, not re-guessed. Cases:
- Real captured response → correct count and field values (grabs/files as
  numbers from `attr[i]["@attributes"]`, size parsed from
  `enclosure["@attributes"].length`, guid extracted to a string).
- Single-item response (`item` is an object, not an array) → one result.
- Single-attr item (`attr` is one `@attributes` object, not an array) → parsed.
- Missing `grabs`/`files` attrs → `null` (not `0`, so sorting can push them to
  the bottom).
- Size from an attr named `size` when no enclosure is present.
- guid given as `{ "@attributes": {...}, "text": "abc" }` → `guid === 'abc'`.
- Malformed input (`null`, `{}`, `{channel:{}}`, a string) → `[]`, no throw.

## Component 2: `nzbgeek.ts` `/search` route change

- After `await response.json()`, call `parseNewznabResults(data)` and respond
  `res.json({ results })` instead of the raw JSON.
- Bump the default `limit` from `'50'` to `'100'` so client-side sorting has a
  fuller set to rank. (Still overridable via the `limit` query param.)
- Error handling unchanged (502 on fetch failure). If parsing yields `[]` the
  route still returns `{ results: [] }` with 200 — an empty result set is not an
  error.

## Component 3: SearchPage — columns + client-side sort

- Replace the local `NzbResult` interface and the `res.data?.channel?.item`
  guessing with: `const results = res.data?.results ?? []` typed to the new
  shape (a local interface mirroring the server's `NzbResult`).
- **`SortKey`** is exactly `'title' | 'category' | 'pubDate' | 'sizeBytes' |
  'files' | 'grabs'`. The **Age** column header maps to the `pubDate` key (Age
  is derived from `pubDate`, it has no field of its own); the other five headers
  map to their like-named keys. This keeps headers and sortable keys in lockstep.
- Columns: **Name, Category, Age, Size, Files, Grabs**, then the existing
  **Action** (Send to SABnzbd) column. `Files`/`Grabs` render `--` when `null`.
- **Sort state:** `{ key: SortKey | null; dir: 'asc' | 'desc' }`, initially
  `{ key: null }` so the indexer's returned order shows first. Clicking a header:
  - if it's a new column → set `key` to it with a sensible initial direction
    (text columns asc; numeric columns — Size/Files/Grabs/Age — desc, since
    "most/newest first" is the common intent);
  - if it's the active column → toggle `dir`.
  - A small arrow (▲/▼) on the active header shows the direction.
- **Sort semantics** (a pure `sortResults(results, key, dir)` helper in the
  component):
  - Numeric keys sort by number: `sizeBytes`, `files`, `grabs`, and `Age`
    (compare by `Date.parse(pubDate)`; older = larger age).
  - `Name`/`Category` sort with `localeCompare` (case-insensitive).
  - **Missing values sort last** regardless of direction: `null` files/grabs,
    `sizeBytes === 0`, and unparseable/empty `pubDate` always sink to the
    bottom, so a real ranking isn't polluted by unknowns at the top. (Note:
    `sizeBytes === 0` intentionally conflates "genuinely 0 bytes" with "unknown
    size" — acceptable, since a real release is never 0 bytes.)
  - **Stable tie-break:** when two rows compare equal on the active key, preserve
    their original (indexer) order. Implement by carrying each row's original
    index and using it as the secondary comparator, so sorting is deterministic
    across browsers rather than relying on `Array.sort` stability alone.
  - Sorting is applied to a copy (never mutate state); rendering maps the sorted
    array. Re-sorting is pure/derived from `results` + sort state.
- `formatSize` stays. `formatAge` is extended to also express months for old
  releases (e.g. "2 mths") to match the screenshot; the underlying sort still
  uses the raw timestamp, so display formatting can't affect ordering.

## Data Flow

`Search` click → `GET /api/nzbgeek/search?q&cat&limit=100` → route fetches
Newznab JSON → `parseNewznabResults` → `{ results: NzbResult[] }` → SearchPage
stores `results` → renders table in indexer order → user clicks a header →
`sortResults` returns a sorted copy → table re-renders. "Send to SABnzbd" posts
the row's `link` exactly as today.

## Error Handling

| Case | Behavior |
|---|---|
| Newznab fetch fails | Route returns 502 (unchanged); client shows no results. |
| Newznab returns unparseable/odd JSON | `parseNewznabResults` returns `[]`; route returns `{ results: [] }` (200); client shows the existing "No results" message. |
| A result missing grabs/files | Field is `null`; renders `--`; sorts to the bottom. |
| A result missing guid+link | Skipped by the parser (not actionable). |
| Empty query | Client no-ops (unchanged); route still 400s if hit directly. |

## Testing Strategy

- **Capture a real fixture FIRST (gates the parser work).** Before writing the
  parser, obtain one real NZBGeek `o=json` response and save it (API key/URL
  redacted) as a test fixture, e.g. `server/src/services/__fixtures__/
  nzbgeek-search.json`. This is the source of truth for the `@attributes` shape.
  Ways to get it: run the dev PC's server with a configured `.env` and
  `curl 'http://localhost:3001/api/...'`; or capture directly from
  `https://api.nzbgeek.info/api?t=search&o=json&q=<term>&apikey=<key>`; or have
  the operator paste one sample. The `@attributes` nesting is already confirmed
  by the repo's existing `enclosure['@attributes']` usage, but the fixture
  locks the parser to reality and prevents a repeat of the original shape guess.
  **Redaction (required):** the API key appears not just in the request URL but
  **inside each item's `link` and `enclosure["@attributes"].url`** (Newznab
  embeds `&apikey=<key>` there). Before committing the fixture, replace every
  occurrence of the real key with `REDACTED` across the whole file. The parser
  only needs the JSON *shape*, so redacted URLs are fine for tests.
- **Parser (real logic):** vitest unit tests using the captured fixture plus the
  synthetic edge cases (single-item, single-attr, missing grabs/files, guid
  object, malformed input), added to the existing server suite
  (`npm test` in `server/`).
- **Route:** covered indirectly; the meaningful logic is the parser. A light
  check that the route returns `{ results }` can be manual/e2e.
- **Client:** no client test framework, so verify by `npm run build` (typecheck)
  plus a manual search — confirm the six columns populate, header clicks sort
  (including reverse and the missing-values-last behavior), and Send to SABnzbd
  still works. Consistent with the repo's approach.

## Risks / Open Questions

- **Field availability varies by indexer/result.** `grabs`/`files`/`usenetdate`
  are standard Newznab attrs and NZBGeek supplies them, but the parser treats
  every field as optional so a missing one degrades to `--`/bottom-sort rather
  than breaking. Low risk.
- **Category display.** The API may return a numeric code, a text label, or
  both. The parser keeps the best-effort text; a nicer code→label mapping (like
  the screenshot's "Movies > UHD") is a possible later polish but is **not** in
  scope here (YAGNI) — we show what the API gives.
- **Response-shape change is a breaking change** for the `/search` endpoint, but
  the only consumer is SearchPage (verified), and both change together in this
  feature.

## Files Touched

**New:**
- `server/src/services/newznab.ts` — `NzbResult` type + `parseNewznabResults`.
- `server/src/services/newznab.test.ts` — parser unit tests.
- `server/src/services/__fixtures__/nzbgeek-search.json` — a **real** captured
  NZBGeek `o=json` response (key/URL redacted), the parser's ground-truth fixture.
- `docs/superpowers/specs/2026-07-02-search-enhancements-design.md` (this file).

**Modified:**
- `server/src/routes/nzbgeek.ts` — `/search` returns `{ results }`; `limit` 50→100.
- `client/src/pages/SearchPage.tsx` — consume `results`; add Files/Grabs columns;
  sortable headers + `sortResults`; extend `formatAge`.
