# Add to Library (Add Show / Add Movie) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing "Add Show" / "Add Movie" modal search results clickable so a click adds the title to Sonarr/Radarr (monitored) and immediately triggers the arr's own search → grab → SAB → import → Plex pipeline.

**Architecture:** Reuse the server `arrAdd` service. Add an optional `search` flag (default `false`, so the existing `send-to-arr` release-push auto-add is unchanged) to the payload builders and `ensure*` helpers; when `true`, the arr searches on add. Expose two thin POST routes registered before each arr's catch-all proxy. Wire the client modals to call them with per-row feedback.

**Tech Stack:** Express 5 + TypeScript (server), Vitest (server unit tests), React 19 + Vite + axios (client). Node native `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-03-add-to-library-design.md`

---

## Chunk 1: Server — arrAdd search flag + add routes

### Task 1: Add `search` flag + movie id-term helper to `arrAdd`

**Files:**
- Modify: `server/src/services/arrAdd.ts`
- Test: `server/src/services/arrAdd.test.ts`

Context: `buildMovieAddPayload` currently hardcodes `addOptions: { searchForMovie: false }` (line ~20); `buildSeriesAddPayload` hardcodes `addOptions: { searchForMissingEpisodes: false }` (line ~44). `ensureMovie` currently takes `(base, imdbId: string)` and looks up `term=imdb:<id>`. We add a `search` param (default `false`) threaded through, a pure `movieLookupTerm` helper, and reshape `ensureMovie` to take an id descriptor.

- [ ] **Step 1: Write the failing tests**

Add these cases to `server/src/services/arrAdd.test.ts`. Update the import line to also import `movieLookupTerm`:

```ts
import { buildMovieAddPayload, buildSeriesAddPayload, movieLookupTerm } from './arrAdd';
```

Append:

```ts
describe('search flag', () => {
  it('buildMovieAddPayload sets searchForMovie from the flag', () => {
    const off = buildMovieAddPayload({ tmdbId: 1 }, 3, '/movies') as Record<string, unknown>;
    expect(off.addOptions).toEqual({ searchForMovie: false }); // default unchanged
    const on = buildMovieAddPayload({ tmdbId: 1 }, 3, '/movies', true) as Record<string, unknown>;
    expect(on.addOptions).toEqual({ searchForMovie: true });
  });

  it('buildSeriesAddPayload sets searchForMissingEpisodes from the flag', () => {
    const lookup = { tvdbId: 1, seasons: [{ seasonNumber: 1, monitored: true }] };
    const off = buildSeriesAddPayload(lookup, 3, '/tv', null) as Record<string, unknown>;
    expect(off.addOptions).toEqual({ searchForMissingEpisodes: false }); // default unchanged
    const on = buildSeriesAddPayload(lookup, 3, '/tv', null, undefined, true) as Record<string, unknown>;
    expect(on.addOptions).toEqual({ searchForMissingEpisodes: true });
  });
});

describe('movieLookupTerm', () => {
  it('prefers tmdb when both ids are present', () => {
    expect(movieLookupTerm({ tmdbId: 27205, imdbId: 'tt1375666' })).toBe('tmdb:27205');
  });
  it('falls back to imdb when no tmdbId', () => {
    expect(movieLookupTerm({ imdbId: 'tt1375666' })).toBe('imdb:tt1375666');
  });
  it('throws when neither id is present', () => {
    expect(() => movieLookupTerm({})).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts`
Expected: FAIL — `movieLookupTerm` is not exported / not a function, and the `search` overloads don't exist yet.

- [ ] **Step 3: Implement the changes in `arrAdd.ts`**

Add the `search` param to both builders (default `false`):

```ts
export function buildMovieAddPayload(
  lookupMovie: Dict,
  qualityProfileId: number,
  rootFolderPath: string,
  search = false
): Dict {
  return {
    ...lookupMovie,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    minimumAvailability: 'released',
    addOptions: { searchForMovie: search },
  };
}
```

```ts
export function buildSeriesAddPayload(
  lookupSeries: Dict,
  qualityProfileId: number,
  rootFolderPath: string,
  season: number | null,
  languageProfileId?: number,
  search = false
): Dict {
  // ...unchanged season-mapping logic...
  const payload: Dict = {
    ...lookupSeries,
    qualityProfileId,
    rootFolderPath,
    monitored: true,
    addOptions: { searchForMissingEpisodes: search },
    seasons: mappedSeasons,
  };
  if (languageProfileId !== undefined) payload.languageProfileId = languageProfileId;
  return payload;
}
```

Add the pure helper near the top (after `type Dict`):

```ts
// Radarr lookups always carry tmdbId; imdbId is not guaranteed. Prefer tmdb.
export function movieLookupTerm(id: { tmdbId?: number; imdbId?: string }): string {
  if (typeof id.tmdbId === 'number' && id.tmdbId > 0) return `tmdb:${id.tmdbId}`;
  if (id.imdbId) return `imdb:${id.imdbId}`;
  throw new Error('movie id requires tmdbId or imdbId');
}
```

Reshape `ensureMovie` to take the descriptor and thread `search`:

```ts
export async function ensureMovie(
  base: ArrBase,
  id: { tmdbId?: number; imdbId?: string },
  search = false
): Promise<{ added: boolean }> {
  const term = movieLookupTerm(id);
  const lookup = await arrGet(base, `/movie/lookup?term=${encodeURIComponent(term)}`);
  const movie = Array.isArray(lookup) ? (lookup[0] as Dict | undefined) : undefined;
  if (!movie) throw new Error(`No movie found for ${term}`);
  const { qualityProfileId, rootFolderPath } = await fetchDefaults(base);
  const res = await fetch(`${base.url}/api/v3/movie`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMovieAddPayload(movie, qualityProfileId, rootFolderPath, search)),
  });
  if (res.ok) return { added: true };
  const body = await res.json().catch(() => null);
  if (looksAlreadyAdded(res.status, body)) return { added: false };
  throw new Error(`Add movie failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
}
```

Thread `search` through `ensureSeries` (add trailing param, pass to builder):

```ts
export async function ensureSeries(
  base: ArrBase,
  tvdbId: number,
  season: number | null,
  search = false
): Promise<{ added: boolean }> {
  // ...unchanged lookup + languageProfileId logic...
  const res = await fetch(`${base.url}/api/v3/series`, {
    method: 'POST',
    headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      buildSeriesAddPayload(series, qualityProfileId, rootFolderPath, season, languageProfileId, search)
    ),
  });
  // ...unchanged ok / looksAlreadyAdded / throw...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts`
Expected: PASS — new cases green AND the pre-existing cases (which assert `searchForMovie: false` / `searchForMissingEpisodes: false` on the default call) still pass because the flag defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/arrAdd.ts server/src/services/arrAdd.test.ts
git commit -m "feat(server): add search flag + movieLookupTerm to arrAdd; reshape ensureMovie id"
```

---

### Task 2: Add routes + update the `send-to-arr` caller

**Files:**
- Modify: `server/src/routes/radarr.ts`
- Modify: `server/src/routes/sonarr.ts`
- Modify: `server/src/routes/nzbgeek.ts` (the `ensureMovie` caller — REQUIRED, build breaks otherwise)

Context: both `radarr.ts` and `sonarr.ts` are pure catch-all proxies (`router.all('/*path', ...)`). Express matches in registration order, so a specific `.post()` **before** the `.all()` wins for that exact path; everything else still falls through to the proxy.

- [ ] **Step 1: Update the `ensureMovie` call site in `nzbgeek.ts`**

`ensureMovie` now takes a descriptor. Find the line in the `/send-to-arr` handler (currently `added = (await ensureMovie(config.radarr, imdbId)).added;`) and change it to:

```ts
added = (await ensureMovie(config.radarr, { imdbId })).added;
```

(The `imdbId` guard `typeof imdbId === 'string' && imdbId` just above it stays. `search` is omitted → defaults to `false`, preserving the release-push behavior. The `ensureSeries` call on the next line is unchanged.)

- [ ] **Step 2: Add the Radarr add route**

At the top of `server/src/routes/radarr.ts`, add imports and register the POST route **before** `radarrRouter.all('/*path', ...)`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';
import { ensureMovie } from '../services/arrAdd';

export const radarrRouter = Router();

// Add a movie to the library AND kick off Radarr's own search (grab -> SAB -> import -> Plex).
radarrRouter.post('/add-movie', async (req: Request, res: Response) => {
  const { tmdbId, imdbId } = req.body ?? {};
  if (typeof tmdbId !== 'number' && typeof imdbId !== 'string') {
    res.status(400).json({ error: 'tmdbId (number) or imdbId (string) is required' });
    return;
  }
  try {
    const { added } = await ensureMovie(config.radarr, { tmdbId, imdbId }, true);
    res.json({ added });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Add movie failed';
    console.error('radarr add-movie error:', message);
    res.status(502).json({ error: message });
  }
});

radarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.radarr.url}/api/v3`,
    apiKey: config.radarr.apiKey,
  });
});
```

- [ ] **Step 3: Add the Sonarr add route**

Mirror it in `server/src/routes/sonarr.ts`:

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from '../config';
import { proxyRequest } from '../services/proxy';
import { ensureSeries } from '../services/arrAdd';

export const sonarrRouter = Router();

// Add a series (whole show monitored) AND search all missing episodes immediately.
sonarrRouter.post('/add-series', async (req: Request, res: Response) => {
  const { tvdbId } = req.body ?? {};
  if (typeof tvdbId !== 'number' || tvdbId <= 0) {
    res.status(400).json({ error: 'tvdbId (positive number) is required' });
    return;
  }
  try {
    const { added } = await ensureSeries(config.sonarr, tvdbId, null, true);
    res.json({ added });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Add series failed';
    console.error('sonarr add-series error:', message);
    res.status(502).json({ error: message });
  }
});

sonarrRouter.all('/*path', (req, res) => {
  proxyRequest(req, res, {
    baseUrl: `${config.sonarr.url}/api/v3`,
    apiKey: config.sonarr.apiKey,
  });
});
```

- [ ] **Step 4: Typecheck the server build**

Run: `cd server && npx tsc --noEmit`
Expected: no errors. (Confirms the reshaped `ensureMovie` signature is consistent across `nzbgeek.ts`, `radarr.ts`, and `arrAdd.ts`.)

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: PASS — all suites, including `arrAdd.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/radarr.ts server/src/routes/sonarr.ts server/src/routes/nzbgeek.ts
git commit -m "feat(server): add /radarr/add-movie and /sonarr/add-series (add + auto-search)"
```

---

## Chunk 2: Client — wire the Add modals

No component test infra exists in this repo, so client tasks verify via `tsc -b` (type safety) and are confirmed end-to-end by the live test in Task 5. Match the existing per-row feedback idiom from `SearchPage.tsx` (a state map keyed per row + `badge-success` / `badge-warning` / `badge-danger` classes, which already exist in `index.css`).

### Task 3: Wire "Add Movie" in `MoviesPage`

**Files:**
- Modify: `client/src/pages/MoviesPage.tsx`

- [ ] **Step 1: Add id fields to the `Movie` interface**

Add two optional fields (lookup results reuse this same interface):

```ts
interface Movie {
  id: number;
  title: string;
  year: number;
  // ...existing fields...
  tmdbId?: number;
  imdbId?: string;
}
```

- [ ] **Step 2: Add add-state and the `addMovie` handler**

Inside the component, near the other `useState` hooks:

```ts
type AddState = 'idle' | 'adding' | 'added' | 'already' | 'error';
const [addState, setAddState] = useState<Record<number, AddState>>({});
```

Add the handler (keyed by result index):

```ts
const addMovie = async (r: Movie, i: number) => {
  setAddState((p) => ({ ...p, [i]: 'adding' }));
  try {
    const res = await api.post('/radarr/add-movie', { tmdbId: r.tmdbId, imdbId: r.imdbId });
    const added = res.data?.added === true;
    setAddState((p) => ({ ...p, [i]: added ? 'added' : 'already' }));
    if (added) fetchMovies();
  } catch {
    setAddState((p) => ({ ...p, [i]: 'error' }));
  }
};
```

- [ ] **Step 3: Render an Add button + status per result row**

Replace the current `searchResults.map(...)` block in the Add Movie modal with:

```tsx
{searchResults.map((r, i) => {
  const st = addState[i] ?? 'idle';
  return (
    <div key={i} className="search-result-item">
      <span>{r.title} ({r.year})</span>
      <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        {st === 'adding' && <span className="placeholder">Adding…</span>}
        {st === 'added' && <span className="badge badge-success">Added — searching</span>}
        {st === 'already' && <span className="badge badge-warning">Already in library</span>}
        {st === 'error' && <span className="badge badge-danger">Error</span>}
        {(st === 'idle' || st === 'error') && (
          <button className="btn-sm btn-primary" onClick={() => addMovie(r, i)}>Add</button>
        )}
      </div>
    </div>
  );
})}
```

- [ ] **Step 4: Typecheck the client build**

Run: `cd client && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/MoviesPage.tsx
git commit -m "feat(client): wire Add Movie modal results to /radarr/add-movie"
```

---

### Task 4: Wire "Add Show" in `TvShowsPage`

**Files:**
- Modify: `client/src/pages/TvShowsPage.tsx`

- [ ] **Step 1: Add `tvdbId` to the `Series` interface**

```ts
interface Series {
  id: number;
  title: string;
  // ...existing fields...
  tvdbId?: number;
}
```

- [ ] **Step 2: Add add-state and the `addSeries` handler**

Near the other `useState` hooks:

```ts
type AddState = 'idle' | 'adding' | 'added' | 'already' | 'error';
const [addState, setAddState] = useState<Record<number, AddState>>({});
```

```ts
const addSeries = async (r: Series, i: number) => {
  setAddState((p) => ({ ...p, [i]: 'adding' }));
  try {
    const res = await api.post('/sonarr/add-series', { tvdbId: r.tvdbId });
    const added = res.data?.added === true;
    setAddState((p) => ({ ...p, [i]: added ? 'added' : 'already' }));
    if (added) fetchSeries();
  } catch {
    setAddState((p) => ({ ...p, [i]: 'error' }));
  }
};
```

- [ ] **Step 3: Render an Add button + status per result row**

Replace the current `searchResults.map(...)` block in the Add TV Show modal with:

```tsx
{searchResults.map((r, i) => {
  const st = addState[i] ?? 'idle';
  return (
    <div key={i} className="search-result-item">
      <span>{r.title} ({r.year})</span>
      <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <span className="placeholder">{r.seasonCount} seasons</span>
        {st === 'adding' && <span className="placeholder">Adding…</span>}
        {st === 'added' && <span className="badge badge-success">Added — searching</span>}
        {st === 'already' && <span className="badge badge-warning">Already in library</span>}
        {st === 'error' && <span className="badge badge-danger">Error</span>}
        {(st === 'idle' || st === 'error') && (
          <button className="btn-sm btn-primary" onClick={() => addSeries(r, i)}>Add</button>
        )}
      </div>
    </div>
  );
})}
```

- [ ] **Step 4: Typecheck the client build**

Run: `cd client && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/TvShowsPage.tsx
git commit -m "feat(client): wire Add Show modal results to /sonarr/add-series"
```

---

### Task 5: Live end-to-end verification (SERVER PC ONLY)

**Files:** none (manual verification).

The arrs are localhost-only to the server PC (see project memory), so this cannot be verified from the dev PC. This task is flagged for the user to run — do NOT mark the feature "working" from the dev PC.

- [ ] **Step 1: Build and deploy** the server + client to the server PC per the normal flow (`npm run build`, restart the NGConnect service).

- [ ] **Step 2: Add a movie.** Open Movies → Add Movie → search a title not yet in the library → click **Add**. Expect "Added — searching". Confirm in Radarr: movie present, monitored, a search/grab queued; SAB receives the download; on completion it imports and Plex refreshes.

- [ ] **Step 3: Add a show.** Open TV Shows → Add Show → search → **Add**. Expect "Added — searching". Confirm in Sonarr: series present, monitored, missing-episode search fired; downloads flow through SAB → import → Plex.

- [ ] **Step 4: Duplicate check.** Add the same title again → expect "Already in library" (not an error).

---

## Definition of Done

- `npx vitest run` passes in `server/` (including new `arrAdd` cases).
- `npx tsc --noEmit` (server) and `npx tsc -b` (client) both clean.
- Clicking an Add-modal result adds the title and shows correct per-row status.
- Existing `/nzbgeek/send-to-arr` behavior is unchanged (no-search auto-add still defaults `search=false`).
- Live add→grab→import→Plex confirmed on the server PC (Task 5).
