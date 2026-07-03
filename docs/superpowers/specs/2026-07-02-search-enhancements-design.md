# Search Enhancements — Design Spec

**Date:** 2026-07-02
**Status:** Approved
**Author:** Zach + Claude

## Problem

The manual search page ([client/src/pages/SearchPage.tsx](../../../client/src/pages/SearchPage.tsx))
has two shortcomings:

1. **Too little information to choose a release.** It shows only Name, Category,
   Size, Age, and nothing is sortable. When a dozen versions of the same title
   match, there's no way to rank them — in particular **grabs** (how many people
   downloaded a release), the best "is this one good" signal, isn't shown.
2. **Grabs go straight to SABnzbd and never get imported.** The "grab" button
   calls `POST /nzbgeek/send-to-sab`, which pushes the NZB directly to SAB via
   `mode=addurl`. Sonarr/Radarr only auto-import (rename → move into library →
   refresh Plex) downloads **they themselves initiated** (matched by SAB's
   `nzo_id`). Anything pushed straight to SAB is never imported and never
   refreshes Plex — it just piles up as untracked files in
   `R:\Torrents\ModernTorrents\completed`. (SAB-side sorting is disabled; the
   arr apps must own naming/importing.)

## Goals

- Show, per result: **Name, Category, Age, Size, Grabs**, every column sortable
  (click header to sort; click again to reverse).
- Route the grab through **Sonarr (TV)** or **Radarr (movies)** so their
  Completed Download Handling runs and Plex refreshes — instead of pushing
  straight to SAB.
- Keep the existing search UX fully intact (free-text NZBGeek search, category
  filter, results table, manual per-release selection).
- Surface the arr's decision clearly: **Grabbed** vs **Rejected: \<reason\>**.

## Non-Goals

- A **Files** column — NZBGeek's search API does not return a file count (see
  Real-API Findings); it only appears on the NZBGeek website. Not shown.
- Thumbs/comments columns — available via the API but the user chose the leaner
  five-column set; not shown. (Trivially addable later.)
- **Auto-adding** unknown series/movies to Sonarr/Radarr. `release/push` only
  succeeds for content already in the library; when it isn't, we surface the
  rejection so the user knows to add it first. Auto-add is a future enhancement.
- Server-side/indexer-side sorting or paging. Sorting is client-side over the
  fetched set.
- A prettier category label like "Movies > UHD" beyond a simple code→label map.

## Real-API Findings (verified live, 2026-07-02)

These drove the design and are **confirmed against the running NZBGeek API**
(the arrs were probed too but are `localhost`-bound and unreachable from the dev
PC — see Verification):

- **`grabs` (and `usenetdate`, `comments`, `thumbsup/down`) require
  `&extended=1`.** A plain `t=search` returns only `category, size, guid,
  coverurl` — no grabs, no age. This is the single most important fix: the route
  MUST send `extended=1`.
- **`files` is NOT returned** by `t=search`, even with `extended=1` (confirmed
  across many results). The Files column is therefore impossible from this API.
- Newznab JSON shape (confirmed): `attr` is an array whose each element is
  `{ "@attributes": { "name", "value" } }` (nested, not flat); `enclosure` is
  `{ "@attributes": { url, length, type } }` with `length` = size in bytes;
  `guid` is a plain **string**; each item carries multiple `category` attrs
  (e.g. `2000` and `2045`) giving the numeric category codes used for routing.
- A **real captured `extended=1` response** (keys redacted) is the parser's test
  fixture — see Testing Strategy.

## Context (current state)

- **Client** [SearchPage.tsx](../../../client/src/pages/SearchPage.tsx): calls
  `GET /api/nzbgeek/search`, reads `res.data?.channel?.item`, renders a table,
  and the grab button posts to `/nzbgeek/send-to-sab`. Has `formatSize` /
  `formatAge` helpers. `/nzbgeek/search` is consumed **only** here (verified).
- **Server** [nzbgeek.ts](../../../server/src/routes/nzbgeek.ts): `/search`
  proxies to NZBGeek and returns raw JSON; `limit` defaults to `'50'`;
  `send-to-sab` appends the NZBGeek key to the NZB url then calls SAB `addurl`.
- **Arr pattern that works:** [TvShowsPage.tsx](../../../client/src/pages/TvShowsPage.tsx)
  posts `/sonarr/command` → [sonarr.ts](../../../server/src/routes/sonarr.ts) →
  [proxy.ts](../../../server/src/services/proxy.ts) forwards to
  `${config.sonarr.url}/api/v3/...` with `X-Api-Key`. `config.sonarr`,
  `config.radarr`, `config.nzbgeek` all hold `{ url, apiKey }` (nzbgeek:
  `{ apiKey, baseUrl }`). The generic proxy can't inject the **NZBGeek** key
  into an arr call, which is why the grab needs a dedicated endpoint.
- **Testing convention:** server unit-tests pure functions with vitest
  (`parseVpnStatus`, `readDeployStatus`). This feature follows that pattern.

## Architecture Overview

Two parts, each with clean unit boundaries:

**Part A — richer results:** a pure server function `parseNewznabResults(raw)`
(new `server/src/services/newznab.ts`) normalizes the Newznab JSON into a typed
`NzbResult[]`; the `/search` route sends `extended=1` and returns `{ results }`;
SearchPage renders and client-side-sorts the array.

**Part B — arr-routed grab:** a new `POST /nzbgeek/send-to-arr` endpoint hands a
release to Sonarr/Radarr via `release/push` (NZBGeek key injected server-side);
SearchPage picks the target from the category and shows the arr's decision. The
old `/send-to-sab` stays as a labeled escape hatch.

The parser knows nothing about the UI; the route knows nothing about sorting;
the grab endpoint returns the raw arr decision so the client owns presentation.

## Component 1: `server/src/services/newznab.ts`

```ts
export interface NzbResult {
  guid: string;
  title: string;
  link: string;            // NZB url; the NZBGeek key is appended server-side later
  category: string;        // display label, best-effort
  categoryId: number | null; // primary numeric Newznab category code, for routing
  sizeBytes: number;       // 0 if unknown
  pubDate: string;         // ISO date string; '' if unknown
  grabs: number | null;    // null if absent
}

export function parseNewznabResults(raw: unknown): NzbResult[];
```

**Behavior (pure, never throws; bad/missing → documented default):**
- Items from `raw.channel.item` or `raw.item`; single object → wrap; else `[]`.
- **`attrMap(item)`**: iterate `item.attr` (normalize a lone object to a
  one-element array); read name/value from `el["@attributes"]` (confirmed
  nested shape), with a flat `el.name`/`el.value` fallback as insurance. Note a
  key like `category` can appear **multiple times** — keep the numeric codes as
  a list for routing.
- **`asString(x)`**: returns a string for `x` that may be a string or an object
  (`x.text` / `x["#text"]`). Used for `guid` and `link` (guid is a string in
  practice, but stay defensive).
- Fields:
  - `guid`: `asString(item.guid)` → fall back to `link`. Must be a usable string
    (React key + send-to-arr/sab).
  - `title`: `item.title` → `''`.
  - `link`: `asString(item.link)` with the **NZBGeek `apikey` stripped**
    (`stripApiKey`) — NZBGeek embeds `&apikey=<key>` inside each `<link>`, and
    returning it in `{ results }` would leak the key to the browser. The grab
    endpoints re-append the key server-side, so stripping is transparent to
    functionality and satisfies the "keys never reach the browser" requirement.
  - `sizeBytes`: `enclosure["@attributes"].length` → attr `size` → `item.size`,
    parsed int; non-numeric → `0`.
  - `pubDate`: **attr `usenetdate`** → `item.pubDate`; original string, `''` if
    absent. (usenetdate is the accurate upload time and needs `extended=1`.)
  - `grabs`: attr `grabs` parsed int; missing/non-numeric → `null`.
  - `categoryId`: the primary numeric category code — from the item's `category`
    attrs/elements, choose the **most specific** (largest) code so e.g. `2045`
    (Movies-UHD) wins over `2000`; `null` if none numeric.
  - `category`: display label — map `categoryId` via a small code→label table
    (extends the client's existing `CATEGORIES`), falling back to the raw
    text/code. (The label map may live client-side; the server guarantees
    `categoryId` + a best-effort string.)
- Items with no usable `guid` **and** no `link` are skipped (not actionable).

**Unit tests** (`server/src/services/newznab.test.ts`): the **primary fixture is
the real captured `extended=1` response** (redacted). Cases: real response →
correct count + grabs/size/usenetdate/categoryId values; single-item response;
single-attr object; missing grabs → `null`; multiple category attrs → most
specific `categoryId`; size from attr when no enclosure; malformed input
(`null`, `{}`, string) → `[]`.

## Component 2: `nzbgeek.ts` `/search` route change

- Add `url.searchParams.set('extended', '1')` (**required** for grabs/age).
- After `await response.json()`, return `res.json({ results: parseNewznabResults(data) })`.
- Bump default `limit` `'50'` → `'100'`.
- Error handling unchanged (502 on fetch failure); `[]` results still 200.

## Component 3: `nzbgeek.ts` new `POST /nzbgeek/send-to-arr`

- Body `{ title, nzbUrl, pubDate, target }`, `target ∈ {'sonarr','radarr'}`.
- **Validate inputs first** (parity with `send-to-sab`): `400` if `nzbUrl` or
  `title` is missing, or if `target` is neither `'sonarr'` nor `'radarr'` —
  never build a `downloadUrl` like `undefined&apikey=...`.
- Build `downloadUrl` by appending the NZBGeek key exactly like `send-to-sab`
  (`nzbUrl.includes('apikey') ? nzbUrl : ${nzbUrl}&apikey=${config.nzbgeek.apiKey}`).
- Pick `{ url, apiKey }` from `config.sonarr` or `config.radarr` by `target`
  (400 if target is neither).
- `POST ${base.url}/api/v3/release/push` with header `X-Api-Key: ${base.apiKey}`,
  `Content-Type: application/json`, body:
  ```json
  { "title": "<title>", "downloadUrl": "<downloadUrl>",
    "protocol": "usenet", "publishDate": "<pubDate || new Date().toISOString()>" }
  ```
  `protocol: "usenet"` is the current-v3 value; **unverified against the live
  instance** (arrs unreachable from dev PC) — the route returns the raw arr
  response + upstream status so a wrong value surfaces as a visible error rather
  than a silent failure, and the live grab test (Verification) confirms it.
- Respond with the arr's status code and JSON body (the decision:
  `approved` / `rejected` / `rejections[]`), so the client can render outcome —
  but **scrub `apikey=` from the echoed body first**: `release/push` echoes the
  pushed release including the keyed `downloadUrl`, which would otherwise
  round-trip the NZBGeek key back to the browser.
- Plain `fetch` + `try/catch` + 502 on connection failure, matching the file's
  style. No API keys sent to the browser. (If any wildcard route is added, use
  Express 5 `/*path` form per CLAUDE.md — none is needed here.)

## Component 4: `/nzbgeek/send-to-sab` (unchanged, kept as fallback)

Retained exactly as-is for the escape-hatch case (grabbing something not in the
libraries, or Audio). The UI labels it as **not** auto-importing.

## Component 5: SearchPage — columns, sort, and arr-routed grab

**Data:** `const results = res.data?.results ?? []` typed to a local interface
mirroring `NzbResult`.

**Columns:** Name, Category, Age, Size, Grabs, then Action. Grabs renders `--`
when `null`. `formatSize` stays; `formatAge` extended to show months for old
releases (display only — sort uses the raw timestamp).

**Sorting (client-side):**
- `SortKey = 'title' | 'category' | 'pubDate' | 'sizeBytes' | 'grabs'`. The Age
  header maps to `pubDate`; the other headers map to like-named keys.
- State `{ key: SortKey | null; dir: 'asc'|'desc' }`, initially `{ key: null }`
  so the indexer's order shows first. New column → set key (text asc; numeric —
  Size/Grabs/Age — desc first); same column → toggle dir. Active header shows ▲/▼.
- `sortResults(results, key, dir)` (pure): numeric keys (`sizeBytes`, `grabs`,
  `pubDate` via `Date.parse`) compare numerically; `title`/`category` use
  `localeCompare` (case-insensitive). **Missing values sort last** regardless of
  direction (`null` grabs, `sizeBytes===0`, empty/unparseable `pubDate`).
  **Stable tie-break:** carry each row's original index as the secondary
  comparator. Sort a copy; never mutate state.

**Grab routing (replaces the single SAB button):**
- Determine target band from the category code: **TV `5000–5999` → sonarr**,
  **Movies `2000–2999` → radarr**, **Audio `3000–3999` → SAB fallback**.
  Precedence: if the **selected category filter** is unambiguous, use it — a
  TV code → sonarr, a Movies code → radarr, and **filter = Audio (3xxx) → the
  primary action is the SAB path** (no arr target); else use the **result's
  `categoryId`** band; if still ambiguous (e.g. filter = "All" and `categoryId`
  null/other), render **two small buttons — "Sonarr" and "Radarr"** — for the
  user to choose. (Routing only needs the thousands-band `Math.floor(code/1000)`;
  TV 5xxx and Movie 2xxx never overlap, so any numeric code in the item is safe.)
- Grab calls `api.post('/nzbgeek/send-to-arr', { title: r.title, nzbUrl: r.link,
  pubDate: r.pubDate, target })`.
- A secondary, **less-prominent "→ SAB"** action (old `send-to-sab` path) is
  always available as the escape hatch, with a tooltip/note that SAB-direct
  grabs won't auto-import.

**Result feedback (per row; replaces the fire-and-forget `sent` set):**
- Track per-guid state: `idle | sending | grabbed | rejected | error` (+ a
  message). Interpreting the arr response: **approved** (`approved === true`, or
  a decision with no `rejections`) → green **"Grabbed"**; **rejected** → red
  **"Rejected: \<first rejection reason\>"** from `rejections[].reason` (this is
  the expected, informative case when the title doesn't match a monitored
  series/movie); non-2xx/`502`/network → **"Error"** with a short message.
- Because `release/push`'s exact success/rejection shape is unverified live, the
  client reads it defensively, in this order:
  1. **Non-2xx from the arr (incl. a 500 on a bad/unmatched release) → Error**,
     never Grabbed. This is the safe failure direction.
  2. A decision carrying any `rejections` **or** `temporarilyRejected` entries →
     **Rejected** (show the first reason). "Rejected" is the intentional
     catch-all for both hard rejections and temporary holds — presence of any
     such entries guarantees a rejected release is never misread as grabbed.
  3. Otherwise (`approved === true`, or 2xx with no rejection entries) → Grabbed.
  The live test confirms these fields.

## Data Flow

**Search:** click → `GET /api/nzbgeek/search?q&cat&limit=100&extended=1` → route
→ `parseNewznabResults` → `{ results }` → table (indexer order) → header click →
`sortResults` copy → re-render.

**Grab (arr):** button → `POST /nzbgeek/send-to-arr {title,nzbUrl,pubDate,target}`
→ server appends NZBGeek key → `POST arr /api/v3/release/push` (X-Api-Key) → arr
decision returned → client shows Grabbed/Rejected. On approval the arr grabs via
its own SAB client (correct category) → CDH → import → Plex refresh.

**Grab (SAB fallback):** button → `POST /nzbgeek/send-to-sab` exactly as today.

## Error Handling

| Case | Behavior |
|---|---|
| NZBGeek fetch fails | `/search` 502; client shows no results. |
| NZBGeek odd/empty JSON | parser → `[]`; 200 `{results:[]}`; "No results". |
| Result missing grabs | `null` → renders `--`, sorts last. |
| Result missing guid+link | skipped by parser. |
| `send-to-arr` missing `nzbUrl`/`title` or bad `target` | 400. |
| arr unreachable | 502; row shows "Error". |
| arr returns non-2xx (incl. 500 on a bad/unmatched release) | row shows "Error", never "Grabbed". |
| arr rejects (not in library / unmonitored / temporary hold) | 2xx decision with `rejections`/`temporarilyRejected`; row shows "Rejected: \<reason\>". |
| `protocol` value wrong (if it is) | arr returns an error body; route passes it through; row shows "Error" with the message — caught in the live test, then adjust. |

## Testing Strategy

- **Capture already done:** a real NZBGeek `extended=1` response was captured
  during design; **redact every apikey** (in the request URL AND in each item's
  `link` / `enclosure["@attributes"].url` — Newznab embeds `&apikey=`) and save
  as `server/src/services/__fixtures__/nzbgeek-search.json`, the parser's
  ground-truth fixture.
- **Parser:** vitest tests over the fixture + synthetic edge cases
  (`npm test` in `server/`).
- **`send-to-arr` route:** the meaningful branching (key injection, target
  selection, pass-through) is thin; a light manual/e2e check suffices. Optionally
  a small unit test of a pure `buildReleasePushUrl(target, config)`-style helper
  if extracted.
- **Client:** no client test framework → `npm run build` (typecheck) + manual.
- **Live grab test (USER-RUN, on the server PC where the arrs are local):**
  1. `npm run dev` (or the deployed build). ProtonVPN connected + SAB un-paused.
  2. Search a show/movie **in** your Sonarr/Radarr library → Grab → confirm it
     appears in the arr's Activity/Queue, downloads via SAB under tv/movies,
     imports into the library, and Plex refreshes.
  3. Search something **not** in the library → confirm a clear
     "Rejected: \<reason\>" (not a silent failure).
  4. Confirm no API keys appear in the browser Network tab.
  5. If the grab errors, report the arr's error body — the likely culprits are
     the `protocol` **value** (`"usenet"` vs `"Usenet"`) or, on older arr
     versions, the field **name** (`protocol` vs `downloadProtocol`). We adjust
     and you re-test. (Because the route passes the raw arr response through,
     this shows as a clear "Error" with the arr's message, not a silent no-op.)

## Risks / Open Questions

- **`release/push` payload unverified live** (protocol casing, exact rejection
  shape). Mitigated by pass-through of the raw arr response + the user-run live
  test. This is the one integration point we can't test from the dev PC.
- **Field availability varies by indexer.** Every field is optional in the
  parser; a missing one degrades to `--`/bottom-sort. `extended=1` is required
  and now always sent.
- **`/search` response-shape change** is breaking, but SearchPage is the only
  consumer (verified) and both change together.
- **Category routing edge cases** (multi-category items, "All" filter) are
  handled by the most-specific-code rule plus the two-button fallback.

## Files Touched

**New:**
- `server/src/services/newznab.ts` — `NzbResult` + `parseNewznabResults`.
- `server/src/services/newznab.test.ts` — parser unit tests.
- `server/src/services/__fixtures__/nzbgeek-search.json` — real captured
  `extended=1` response (keys redacted).
- `docs/superpowers/specs/2026-07-02-search-enhancements-design.md` (this file).

**Modified:**
- `server/src/routes/nzbgeek.ts` — `/search` adds `extended=1`, returns
  `{ results }`, `limit` 50→100; new `POST /send-to-arr`; `send-to-sab` kept.
- `client/src/pages/SearchPage.tsx` — consume `results`; Name/Category/Age/Size/
  Grabs sortable columns; arr-routed grab with Sonarr/Radarr/SAB targeting;
  Grabbed/Rejected/Error feedback; extend `formatAge`.
