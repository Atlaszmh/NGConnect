# Auto-Add on Grab Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When grabbing a Search result that isn't in Radarr/Sonarr yet, auto-add it by ID (IMDb for movies, TVDB for TV), monitored, into the single quality profile + root folder, then push the release — so search→arr→SAB→import→Plex works without pre-adding.

**Architecture:** The parser extracts `imdbId`/`tvdbId`/`season`/`episode` from NZBGeek `extended=1` results. A new `arrAdd` service holds pure, unit-tested payload builders plus thin `ensureMovie`/`ensureSeries` orchestrators (lookup-by-id → add if missing, treating "already exists" as a no-op). `/send-to-arr` runs ensure-in-library then push, returning `{ added, push }`. SearchPage sends the IDs and shows "Added + Grabbed" vs "Grabbed".

**Tech Stack:** Express 5 + TypeScript (server), React 19 + Vite (client), vitest (server, pure-function tests), plain `fetch` for arrs.

**Spec:** [docs/superpowers/specs/2026-07-02-auto-add-on-grab-design.md](../specs/2026-07-02-auto-add-on-grab-design.md)

**Branch:** `feature/auto-add-on-grab` (already checked out). NOT merged to `main` until the end, so nothing auto-deploys mid-change.

---

## File Structure

**New:**
- `server/src/services/arrAdd.ts` — `ArrBase` type, `buildMovieAddPayload`, `buildSeriesAddPayload`, default pickers, `ensureMovie`, `ensureSeries`.
- `server/src/services/arrAdd.test.ts` — unit tests for the pure builders (incl. season-monitoring + no-match fallback).
- `server/src/services/__fixtures__/nzbgeek-search-tv.json` — real TV fixture. **Already created + committed** (commit `f86cd4c`).

**Modified:**
- `server/src/services/newznab.ts` — add `formatImdbId`, extract `imdbId`/`tvdbId`/`season`/`episode`.
- `server/src/services/newznab.test.ts` — cases for the new fields (both real fixtures).
- `server/src/routes/nzbgeek.ts` — `/send-to-arr` ensures-then-pushes, returns `{ added, push }`.
- `client/src/pages/SearchPage.tsx` — send IDs; read `{ added, push }`; "Added + Grabbed".

---

## Chunk 1: Server — parser IDs + arrAdd service

### Task 1: Parser extracts IDs (`formatImdbId`, tvdbId, season, episode) — TDD

**Files:**
- Modify: `server/src/services/newznab.ts`
- Modify: `server/src/services/newznab.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/src/services/newznab.test.ts`:

```ts
import { parseNewznabResults, formatImdbId } from './newznab';

describe('formatImdbId', () => {
  it('zero-pads NZBGeek imdb to tt#######', () => {
    expect(formatImdbId('01375666')).toBe('tt1375666');
    expect(formatImdbId('00133093')).toBe('tt0133093');
  });
  it('handles 8-digit ids', () => {
    expect(formatImdbId('10872600')).toBe('tt10872600');
  });
  it('returns null for empty/garbage', () => {
    expect(formatImdbId('')).toBeNull();
    expect(formatImdbId(undefined)).toBeNull();
    expect(formatImdbId('tt123')).toBeNull(); // non-numeric -> null, not ttNaN
  });
});

describe('parseNewznabResults — IDs', () => {
  it('extracts imdbId from the real movies fixture', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8')
    );
    const results = parseNewznabResults(raw);
    expect(results.every((r) => r.imdbId === null || /^tt\d{7,}$/.test(r.imdbId))).toBe(true);
    expect(results.some((r) => r.imdbId !== null)).toBe(true);
  });
  it('extracts tvdbId/season/episode from the real TV fixture', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search-tv.json'), 'utf-8')
    );
    const results = parseNewznabResults(raw);
    expect(results.some((r) => r.tvdbId === 361753)).toBe(true);
    expect(results.some((r) => r.season === 1)).toBe(true);
    // a season pack has episode 0 (E00), which must parse to 0, not null
    expect(results.some((r) => r.episode === 0)).toBe(true);
  });
  it('leaves TV ids null on a movie item and vice versa', () => {
    const movies = parseNewznabResults(
      JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8'))
    );
    expect(movies.every((r) => r.tvdbId === null)).toBe(true);
  });
});
```

(`fs`/`path` are already imported at the top of the file from the existing fixture test. If not, add `import fs from 'fs'; import path from 'path';`.)

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/services/newznab.test.ts`
Expected: FAIL — `formatImdbId` not exported; `r.imdbId`/`r.tvdbId` undefined.

- [ ] **Step 3: Implement**

In `server/src/services/newznab.ts`, add the `NzbResult` fields (after `grabs`):

```ts
  imdbId: string | null;   // 'tt#######' (movies), else null
  tvdbId: number | null;   // TV series id, else null
  season: number | null;   // grabbed season number (from 'S01'), else null
  episode: number | null;  // grabbed episode number (from 'E00'), else null (0 for season packs)
```

Add the helpers (near `toInt`):

```ts
export function formatImdbId(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return 'tt' + String(n).padStart(7, '0');
}

// Parse 'S01' / 'E00' / '1' -> the integer (0 is valid, e.g. E00 season pack).
function parseSxxExx(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}
```

In the `results.push({...})` object, add the four fields:

```ts
      imdbId: formatImdbId(attrs.first.get('imdb')),
      tvdbId: toInt(attrs.first.get('tvdbid')),
      season: parseSxxExx(attrs.first.get('season')),
      episode: parseSxxExx(attrs.first.get('episode')),
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/services/newznab.test.ts`
Expected: PASS.

- [ ] **Step 5: Full server suite**

Run: `cd server && npm test`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/newznab.ts server/src/services/newznab.test.ts
git commit -m "feat(server): parser extracts imdbId/tvdbId/season/episode"
```

---

### Task 2: `arrAdd` service — pure builders (TDD) + ensure orchestrators

**Files:**
- Create: `server/src/services/arrAdd.ts`
- Test: `server/src/services/arrAdd.test.ts`

- [ ] **Step 1: Write failing tests for the pure builders**

Create `server/src/services/arrAdd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMovieAddPayload, buildSeriesAddPayload } from './arrAdd';

describe('buildMovieAddPayload', () => {
  it('enriches the lookup object; our fields override', () => {
    const lookup = { tmdbId: 27205, title: 'Inception', monitored: false, addOptions: { searchForMovie: true } };
    const p = buildMovieAddPayload(lookup, 3, '/movies') as Record<string, unknown>;
    expect(p.tmdbId).toBe(27205);
    expect(p.qualityProfileId).toBe(3);
    expect(p.rootFolderPath).toBe('/movies');
    expect(p.monitored).toBe(true); // overrides lookup's false
    expect(p.minimumAvailability).toBe('released');
    expect(p.addOptions).toEqual({ searchForMovie: false }); // overrides lookup
  });
});

describe('buildSeriesAddPayload', () => {
  const lookup = () => ({
    tvdbId: 361753, title: 'The Mandalorian',
    seasons: [{ seasonNumber: 0, monitored: true }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }],
  });
  it('monitors only the grabbed season, unmonitors the rest', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1) as Record<string, unknown>;
    expect(p.qualityProfileId).toBe(3);
    expect(p.monitored).toBe(true);
    expect(p.addOptions).toEqual({ searchForMissingEpisodes: false });
    expect(p.seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
    ]);
    expect('languageProfileId' in p).toBe(false);
  });
  it('season pack (season known) still monitors that season', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    expect(p.seasons.find((s) => s.seasonNumber === 1)?.monitored).toBe(true);
  });
  it('falls back to ALL seasons monitored when season is null or no match', () => {
    const pNull = buildSeriesAddPayload(lookup(), 3, '/tv', null) as { seasons: { monitored: boolean }[] };
    expect(pNull.seasons.every((s) => s.monitored)).toBe(true);
    const pNoMatch = buildSeriesAddPayload(lookup(), 3, '/tv', 9) as { seasons: { monitored: boolean }[] };
    expect(pNoMatch.seasons.every((s) => s.monitored)).toBe(true);
  });
  it('includes languageProfileId only when provided', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1, 2) as Record<string, unknown>;
    expect(p.languageProfileId).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts`
Expected: FAIL — cannot resolve `./arrAdd`.

- [ ] **Step 3: Implement `arrAdd.ts`**

Create `server/src/services/arrAdd.ts`:

```ts
export interface ArrBase {
  url: string;
  apiKey: string;
}

type Dict = Record<string, unknown>;

export function buildMovieAddPayload(
  lookupMovie: Dict,
  qualityProfileId: number,
  rootFolderPath: string
): Dict {
  // Spread lookup FIRST, then our enrichment so our values win.
  return {
    ...lookupMovie,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    minimumAvailability: 'released',
    addOptions: { searchForMovie: false },
  };
}

export function buildSeriesAddPayload(
  lookupSeries: Dict,
  qualityProfileId: number,
  rootFolderPath: string,
  season: number | null,
  languageProfileId?: number
): Dict {
  const seasons = Array.isArray(lookupSeries.seasons)
    ? (lookupSeries.seasons as Array<Dict>)
    : [];
  const hasMatch = season !== null && seasons.some((s) => s.seasonNumber === season);
  const mappedSeasons = seasons.map((s) => ({
    ...s,
    monitored: hasMatch ? s.seasonNumber === season : true, // no match/null -> all monitored
  }));
  const payload: Dict = {
    ...lookupSeries,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    addOptions: { searchForMissingEpisodes: false },
    seasons: mappedSeasons,
  };
  if (languageProfileId !== undefined) payload.languageProfileId = languageProfileId;
  return payload;
}

// ---- integration helpers (call the arr; exercised in the live test) ----

async function arrGet(base: ArrBase, path: string): Promise<unknown> {
  const r = await fetch(`${base.url}/api/v3${path}`, {
    headers: { 'X-Api-Key': base.apiKey },
  });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json();
}

async function fetchDefaults(base: ArrBase): Promise<{ qualityProfileId: number; rootFolderPath: string }> {
  const [profiles, folders] = await Promise.all([
    arrGet(base, '/qualityprofile'),
    arrGet(base, '/rootfolder'),
  ]);
  const qualityProfileId = Array.isArray(profiles) ? profiles[0]?.id : undefined;
  const rootFolderPath = Array.isArray(folders) ? folders[0]?.path : undefined;
  if (!qualityProfileId) throw new Error('No quality profile configured in the app');
  if (!rootFolderPath) throw new Error('No root folder configured in the app');
  return { qualityProfileId, rootFolderPath };
}

function looksAlreadyAdded(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 409) return false;
  const text = JSON.stringify(body ?? '').toLowerCase();
  return text.includes('already') || text.includes('exist');
}

export async function ensureMovie(base: ArrBase, imdbId: string): Promise<{ added: boolean }> {
  const lookup = await arrGet(base, `/movie/lookup?term=imdb:${encodeURIComponent(imdbId)}`);
  const movie = Array.isArray(lookup) ? (lookup[0] as Dict | undefined) : undefined;
  if (!movie) throw new Error(`No movie found for ${imdbId}`);
  const { qualityProfileId, rootFolderPath } = await fetchDefaults(base);
  const res = await fetch(`${base.url}/api/v3/movie`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMovieAddPayload(movie, qualityProfileId, rootFolderPath)),
  });
  if (res.ok) return { added: true };
  const body = await res.json().catch(() => null);
  if (looksAlreadyAdded(res.status, body)) return { added: false };
  throw new Error(`Add movie failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}

export async function ensureSeries(
  base: ArrBase,
  tvdbId: number,
  season: number | null
): Promise<{ added: boolean }> {
  const lookup = await arrGet(base, `/series/lookup?term=tvdb:${tvdbId}`);
  const series = Array.isArray(lookup) ? (lookup[0] as Dict | undefined) : undefined;
  if (!series) throw new Error(`No series found for tvdb ${tvdbId}`);
  const { qualityProfileId, rootFolderPath } = await fetchDefaults(base);
  // languageProfileId is required on Sonarr v3, removed on v4: include only if the endpoint exists.
  let languageProfileId: number | undefined;
  try {
    const langs = await arrGet(base, '/languageprofile');
    if (Array.isArray(langs) && langs[0]?.id) languageProfileId = langs[0].id;
  } catch {
    /* v4: /languageprofile 404s — omit the field */
  }
  const res = await fetch(`${base.url}/api/v3/series`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSeriesAddPayload(series, qualityProfileId, rootFolderPath, season, languageProfileId)),
  });
  if (res.ok) return { added: true };
  const body = await res.json().catch(() => null);
  if (looksAlreadyAdded(res.status, body)) return { added: false };
  throw new Error(`Add series failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + full suite**

Run: `cd server && npm run build && npm test`
Expected: `tsc` exit 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/arrAdd.ts server/src/services/arrAdd.test.ts
git commit -m "feat(server): add arrAdd service (add-payload builders + ensureMovie/ensureSeries)"
```

---

## Chunk 2: Server — `/send-to-arr` ensures then pushes

### Task 3: Extend `/send-to-arr`

**Files:**
- Modify: `server/src/routes/nzbgeek.ts`

- [ ] **Step 1: Import the ensure functions**

At the top of `server/src/routes/nzbgeek.ts` add:

```ts
import { ensureMovie, ensureSeries } from '../services/arrAdd';
```

- [ ] **Step 2: Extend the handler**

In the `POST /send-to-arr` handler, change the destructure to pull the IDs (do NOT destructure `episode` — it's unused server-side and would trip `noUnusedLocals`):

```ts
  const { title, nzbUrl, pubDate, target, imdbId, tvdbId, season } = req.body ?? {};
```

Keep the existing string/target validation. Then, **after validation and before building `downloadUrl`**, add the ensure step:

```ts
  // Ensure the movie/show is in the library (idempotent) so release/push can match it.
  let added = false;
  try {
    if (target === 'radarr' && typeof imdbId === 'string' && imdbId) {
      added = (await ensureMovie(config.radarr, imdbId)).added;
    } else if (target === 'sonarr' && typeof tvdbId === 'number' && tvdbId > 0) {
      added = (await ensureSeries(config.sonarr, tvdbId, typeof season === 'number' ? season : null)).added;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Auto-add failed';
    console.error(`send-to-arr ensure [${target}] error:`, message);
    res.status(502).json({ error: message });
    return;
  }
```

Then, in the push section, change the final JSON response to **nest** the push body under `push` and include `added`. The existing block:

```ts
    if (contentType.includes('application/json')) {
      const body = await response.json();
      const scrubbed = JSON.parse(
        JSON.stringify(body).replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED')
      );
      res.json(scrubbed);
    } else {
      const text = await response.text();
      res.send(text.replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED'));
    }
```

becomes:

```ts
    if (contentType.includes('application/json')) {
      const body = await response.json();
      const scrubbed = JSON.parse(
        JSON.stringify(body).replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED')
      );
      res.json({ added, push: scrubbed });
    } else {
      const text = await response.text();
      res.json({ added, push: text.replace(/apikey=[^&"\\]+/gi, 'apikey=REDACTED') });
    }
```

(Both branches now return `{ added, push }`; the text branch wraps the scrubbed text as `push` so the envelope is uniform. The `res.status(response.status)` call before this stays.)

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: `tsc` exit 0. If `noUnusedLocals` complains about `episode`, confirm it was NOT destructured.

- [ ] **Step 4: Full suite + leak scan**

Run: `cd server && npm test` (expect green), then `cd /c/Projects/NGConnect && git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ | grep -v "apikey=REDACTED" && echo LEAK || echo "no keys - good"`
Expected: tests pass; "no keys - good".

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/nzbgeek.ts
git commit -m "feat(server): /send-to-arr auto-adds to library then pushes, returns {added, push}"
```

---

## Chunk 3: Client — send IDs + "Added + Grabbed"

### Task 4: SearchPage sends IDs and reads the new envelope

**Files:**
- Modify: `client/src/pages/SearchPage.tsx`

Single build gate at the end. No client test framework — build is the check.

- [ ] **Step 1: Add the ID fields to the client `NzbResult`**

In `SearchPage.tsx`, add to the `NzbResult` interface (they flow through automatically because `doSearch` maps `{...r, rowId}`):

```ts
  imdbId: string | null;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
```

- [ ] **Step 2: Send the IDs in `grabToArr` and read `{ added, push }`**

Replace the body of `grabToArr` with:

```ts
  const grabToArr = async (r: NzbResult, target: ArrTarget) => {
    setRow(r.rowId, { state: 'sending' });
    try {
      const res = await api.post('/nzbgeek/send-to-arr', {
        title: r.title, nzbUrl: r.link, pubDate: r.pubDate, target,
        imdbId: r.imdbId, tvdbId: r.tvdbId, season: r.season, episode: r.episode,
      });
      const added = res.data?.added === true;
      const outcome = interpretPush(res.status, res.data?.push);
      if (outcome.state === 'grabbed') {
        setRow(r.rowId, { state: 'grabbed', msg: added ? 'Added + Grabbed' : 'Grabbed' });
      } else {
        setRow(r.rowId, outcome);
      }
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const data = (err as { response?: { data?: unknown } })?.response?.data;
      setRow(r.rowId, interpretPush(status ?? 0, data));
    }
  };
```

(Note: on a thrown non-2xx, the route returns `{ error }`, and `interpretPush(status, {error})` hits its non-2xx branch → "Error" reading `.error`. On 2xx it reads `res.data.push`, never the raw `res.data`, so the nested envelope is handled correctly.)

- [ ] **Step 3: Render the "Added + Grabbed" message on the grabbed badge**

Find the grabbed badge in the Action cell and make it render the stored message:

```tsx
if (g === 'grabbed') return <span className="badge badge-success" title={grab[r.rowId]?.msg}>{grab[r.rowId]?.msg || 'Grabbed'}</span>;
```

**Side effect to handle:** the SAB path (`grabToSab`) also reaches the `'grabbed'`
state and currently sets `msg: 'Sent to SAB (no auto-import)'` — which is too long
for a badge. Shorten it in `grabToSab` to `msg: 'Sent to SAB'` (the "won't
auto-import" wording already lives in the `→ SAB` button's `title` tooltip). Now
the badge reads: "Added + Grabbed" (auto-added via arr), "Grabbed" (was already
in the arr library), or "Sent to SAB" (escape hatch).

- [ ] **Step 4: Build the client**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SearchPage.tsx
git commit -m "feat(client): send IDs to auto-add, show 'Added + Grabbed'"
```

---

## Chunk 4: Verification and rollout

### Task 5: Full local verification

- [ ] **Step 1: Server tests + build**

Run: `cd server && npm test && npm run build`
Expected: all tests pass; `tsc` exit 0.

- [ ] **Step 2: Client build**

Run: `cd client && npm run build`
Expected: no type errors.

- [ ] **Step 3: No secrets committed**

Run:
```bash
cd /c/Projects/NGConnect
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK" || echo "no embedded keys - good"
```
Expected: "no embedded keys - good".

---

### Task 6: Merge to main, then USER-RUN live test on the server PC

The arr add/lookup is `localhost`-only — the live add→import flow is a server-PC test. Merging to `main` deploys it there.

- [ ] **Step 1: Merge and push**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff feature/auto-add-on-grab -m "feat: auto-add movie/show to Radarr/Sonarr on grab"
git push origin main
```
Expected: push succeeds; server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 2: USER-RUN — grab a movie NOT in the library**

On the server PC (VPN connected, SAB un-paused): search a movie that is NOT in Radarr, Grab it. Expect the row to show **Added + Grabbed**; confirm the movie now appears in Radarr (monitored), downloads via SAB, imports, and Plex refreshes.

- [ ] **Step 3: USER-RUN — grab a TV episode/season NOT in the library**

Search a show NOT in Sonarr, Grab an episode/season. Expect **Added + Grabbed**; confirm the series appears in Sonarr with the grabbed season monitored, and the release downloads → imports → Plex. **This is the key check** — if the pushed episode is rejected as "unmonitored", report it: the fix is to also set `addOptions.monitor` or monitor the exact episode after add.

- [ ] **Step 4: USER-RUN — grab something already in the library**

Grab a release for a movie/show already tracked → expect plain **Grabbed** (added:false), and it still imports.

- [ ] **Step 5: USER-RUN — no key leak**

Browser Network tab on a grab → confirm no NZBGeek/Sonarr/Radarr keys are visible in requests or responses (the arr echo is scrubbed).

- [ ] **Step 6: If an add errors**

Read the arr's message (passed through). Likely: Sonarr `languageProfileId` (v3) — the code includes it only if `/languageprofile` exists, so a v3 that still rejects means the value/shape needs a tweak; Radarr `minimumAvailability`; or a profile/root-folder issue. Report it → controller adjusts `arrAdd.ts` → push → re-test after redeploy.

---

## Done criteria

- [ ] Parser extracts `imdbId`/`tvdbId`/`season`/`episode`; tests over both real fixtures pass.
- [ ] `arrAdd` pure builders unit-tested (season-monitoring incl. no-match fallback, override order, languageProfileId conditional).
- [ ] `/send-to-arr` ensures-in-library then pushes, returns `{ added, push }`; no key leak.
- [ ] SearchPage sends IDs and shows "Added + Grabbed" / "Grabbed" / Rejected / Error.
- [ ] Server `tsc` + client `vite` build clean; no committed keys.
- [ ] Live test on the server PC: a not-in-library movie AND show each end Added + Grabbed → import → Plex; an already-present one shows Grabbed.
