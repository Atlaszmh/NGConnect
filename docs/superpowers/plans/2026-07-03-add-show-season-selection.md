# Add-Show Season Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which seasons to monitor when adding a show, so they can grab e.g. just Season 1 to try it.

**Architecture:** Generalize the shared `buildSeriesAddPayload`/`ensureSeries` season parameter from `number | null` to a season set `number[] | null` (monitor exactly those, null/empty/no-match → all). Update both callers. Add a per-season checklist to the Add-Show modal.

**Tech Stack:** Express 5 + TypeScript (server), React 19 + Vite (client), vitest.

**Spec:** [docs/superpowers/specs/2026-07-03-add-show-season-selection-design.md](../specs/2026-07-03-add-show-season-selection-design.md)

**Branch:** `feature/add-show-seasons` (already checked out). NOT merged to `main` until the end.

---

## File Structure

**Modified:**
- `server/src/services/arrAdd.ts` — `buildSeriesAddPayload`/`ensureSeries` take `seasons: number[] | null`.
- `server/src/services/arrAdd.test.ts` — updated signature + season-set cases.
- `server/src/routes/sonarr.ts` — `/add-series` accepts `seasons?: number[]`.
- `server/src/routes/nzbgeek.ts` — auto-add `ensureSeries` call passes `[season]`.
- `client/src/pages/TvShowsPage.tsx` — season checklist in the Add-Show modal.

---

## Chunk 1: Server — season set through the shared pipeline

### Task 1: Generalize `buildSeriesAddPayload`/`ensureSeries` to a season set (+ update both callers & tests)

This is one cohesive change: the signature change ripples to two callers and the tests, so they move together (or the build breaks).

**Files:**
- Modify: `server/src/services/arrAdd.ts`
- Modify: `server/src/services/arrAdd.test.ts`
- Modify: `server/src/routes/sonarr.ts`
- Modify: `server/src/routes/nzbgeek.ts`

- [ ] **Step 1: Update the tests to the new `number[] | null` signature (TDD)**

In `server/src/services/arrAdd.test.ts`, update the `buildSeriesAddPayload` calls and add season-set cases. Replace the `describe('buildSeriesAddPayload', …)` block with:

```ts
describe('buildSeriesAddPayload', () => {
  const lookup = () => ({
    tvdbId: 361753, title: 'The Mandalorian',
    seasons: [{ seasonNumber: 0, monitored: true }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }],
  });
  it('monitors exactly the selected season(s), unmonitors the rest (incl. season 0)', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1]) as Record<string, unknown>;
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
  it('monitors a multi-season selection', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1, 2]) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    expect(p.seasons.find((s) => s.seasonNumber === 0)?.monitored).toBe(false);
    expect(p.seasons.find((s) => s.seasonNumber === 1)?.monitored).toBe(true);
    expect(p.seasons.find((s) => s.seasonNumber === 2)?.monitored).toBe(true);
  });
  it('falls back to ALL seasons monitored when seasons is null, empty, or matches none', () => {
    const pNull = buildSeriesAddPayload(lookup(), 3, '/tv', null) as { seasons: { monitored: boolean }[] };
    expect(pNull.seasons.every((s) => s.monitored)).toBe(true);
    const pEmpty = buildSeriesAddPayload(lookup(), 3, '/tv', []) as { seasons: { monitored: boolean }[] };
    expect(pEmpty.seasons.every((s) => s.monitored)).toBe(true);
    const pNoMatch = buildSeriesAddPayload(lookup(), 3, '/tv', [9]) as { seasons: { monitored: boolean }[] };
    expect(pNoMatch.seasons.every((s) => s.monitored)).toBe(true);
  });
  it('includes languageProfileId only when provided', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1], 2) as Record<string, unknown>;
    expect(p.languageProfileId).toBe(2);
  });
});
```

Also, in the `describe('search flag', …)` block, the two `buildSeriesAddPayload(lookup, 3, '/tv', null …)` calls already pass `null` — leave them as `null` (valid for `number[] | null`). No change needed there.

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts`
Expected: FAIL (type error / assertion mismatch — the old `buildSeriesAddPayload` takes `number|null`, so passing `[1]` is a type error, or the impl doesn't match the new expectations).

- [ ] **Step 3: Update `buildSeriesAddPayload` in `arrAdd.ts`**

Replace the current `buildSeriesAddPayload` with:

```ts
export function buildSeriesAddPayload(
  lookupSeries: Dict,
  qualityProfileId: number,
  rootFolderPath: string,
  seasons: number[] | null,   // null/empty → monitor ALL; else monitor exactly these
  languageProfileId?: number,
  search = false
): Dict {
  const lookupSeasons = Array.isArray(lookupSeries.seasons)
    ? (lookupSeries.seasons as Array<Dict>)
    : [];
  const wantAll = !seasons || seasons.length === 0;
  const selected = new Set(seasons ?? []);
  // Safety: if a non-empty selection matches none of the lookup seasons,
  // fall back to all-monitored — never add a fully-unmonitored show.
  const anyMatch = !wantAll && lookupSeasons.some((s) => selected.has(s.seasonNumber as number));
  const mappedSeasons = lookupSeasons.map((s) => ({
    ...s,
    monitored: wantAll || !anyMatch ? true : selected.has(s.seasonNumber as number),
  }));
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

- [ ] **Step 4: Update `ensureSeries` in `arrAdd.ts`**

Change its signature and the value passed to the builder:

```ts
export async function ensureSeries(
  base: ArrBase,
  tvdbId: number,
  seasons: number[] | null,
  search = false
): Promise<{ added: boolean }> {
```

and (inside, in the `body: JSON.stringify(buildSeriesAddPayload(series, qualityProfileId, rootFolderPath, season, languageProfileId, search))`) change `season` to `seasons`:

```ts
    body: JSON.stringify(buildSeriesAddPayload(series, qualityProfileId, rootFolderPath, seasons, languageProfileId, search)),
```

(The rest of `ensureSeries` — lookup, defaults, languageProfileId, already-added handling — is unchanged.)

- [ ] **Step 5: Update both callers**

`server/src/routes/nzbgeek.ts` (~line 124, the auto-add path) — wrap the single season as an array:

```ts
      added = (await ensureSeries(config.sonarr, tvdbId, typeof season === 'number' ? [season] : null)).added;
```

`server/src/routes/sonarr.ts` `/add-series` — accept and validate `seasons`, pass it through:

```ts
sonarrRouter.post('/add-series', async (req: Request, res: Response) => {
  const { tvdbId, seasons } = req.body ?? {};
  if (typeof tvdbId !== 'number' || tvdbId <= 0) {
    res.status(400).json({ error: 'tvdbId (positive number) is required' });
    return;
  }
  if (seasons !== undefined && (!Array.isArray(seasons) || !seasons.every((n) => typeof n === 'number'))) {
    res.status(400).json({ error: 'seasons must be an array of numbers' });
    return;
  }
  try {
    const { added } = await ensureSeries(config.sonarr, tvdbId, Array.isArray(seasons) ? seasons : null, true);
    res.json({ added });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Add series failed';
    console.error('sonarr add-series error:', message);
    res.status(502).json({ error: message });
  }
});
```

- [ ] **Step 6: Run tests + build**

Run: `cd server && npx vitest run src/services/arrAdd.test.ts` then `npm test` then `npm run build`
Expected: the buildSeriesAddPayload tests pass; full suite green; `tsc` exit 0 (both callers compile with the new signature).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/arrAdd.ts server/src/services/arrAdd.test.ts server/src/routes/sonarr.ts server/src/routes/nzbgeek.ts
git commit -m "feat(server): monitor a set of seasons on add (season[]); /add-series accepts seasons"
```

---

## Chunk 2: Client — season checklist in the Add-Show modal

### Task 2: Season picker

**Files:**
- Modify: `client/src/pages/TvShowsPage.tsx`

No client test framework — the build is the gate; live behavior is Task 3.

- [ ] **Step 1: Add `seasons` to the `Series` interface**

Add to the `Series` interface (after `tvdbId?`):

```tsx
  seasons?: { seasonNumber: number; monitored?: boolean }[];
```

- [ ] **Step 2: Add checked-season state, init on search, reset with the modal**

Add state near the other add states:

```tsx
  const [checkedSeasons, setCheckedSeasons] = useState<Record<number, number[]>>({});
```

In `searchForShow()`, after `setSearchResults(...)`, initialize the checked set for each result to all **real** seasons (seasonNumber ≥ 1); and reset it alongside the existing resets. Concretely, change the success path:

```tsx
      const results: Series[] = Array.isArray(res.data) ? res.data : [];
      setSearchResults(results);
      const cs: Record<number, number[]> = {};
      results.forEach((r, i) => {
        cs[i] = (r.seasons ?? []).filter((s) => s.seasonNumber >= 1).map((s) => s.seasonNumber);
      });
      setCheckedSeasons(cs);
```

and add `setCheckedSeasons({});` next to the `setAddState({}); setSearchResults([]);` reset at the top of `searchForShow`, AND next to the resets in the "Add Show" header button `onClick` (the `{ setShowAddModal(true); setAddState({}); setSearchResults([]); setAddQuery(''); }` — add `setCheckedSeasons({});`).

- [ ] **Step 3: Add a season toggle helper**

```tsx
  const toggleSeason = (i: number, seasonNumber: number) => {
    setCheckedSeasons((p) => {
      const cur = p[i] ?? [];
      const next = cur.includes(seasonNumber)
        ? cur.filter((n) => n !== seasonNumber)
        : [...cur, seasonNumber];
      return { ...p, [i]: next };
    });
  };
```

- [ ] **Step 4: Post the selection in `addSeries`**

Change `addSeries` to include the selected seasons (omit when the result has no `seasons` array → server monitors all):

```tsx
  const addSeries = async (r: Series, i: number) => {
    setAddState((p) => ({ ...p, [i]: 'adding' }));
    try {
      const body = r.seasons ? { tvdbId: r.tvdbId, seasons: checkedSeasons[i] ?? [] } : { tvdbId: r.tvdbId };
      const res = await api.post('/sonarr/add-series', body);
      const added = res.data?.added === true;
      setAddState((p) => ({ ...p, [i]: added ? 'added' : 'already' }));
      if (added) fetchSeries();
    } catch {
      setAddState((p) => ({ ...p, [i]: 'error' }));
    }
  };
```

- [ ] **Step 5: Render the checklist + gate the Add button**

In the Add-Show modal's result row (currently `<span className="placeholder">{r.seasonCount} seasons</span>` and the Add button), replace the season span with a checklist and disable Add when a checklist is shown but nothing is checked. Replace the inner content of the `grab-actions` div so the result row reads:

```tsx
                  <div key={i} className="search-result-item">
                    <span>{r.title} ({r.year})</span>
                    <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {r.seasons && r.seasons.some((s) => s.seasonNumber >= 1) ? (
                        <span style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          {r.seasons
                            .filter((s) => s.seasonNumber >= 1)
                            .map((s) => (
                              <label key={s.seasonNumber} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', fontSize: '0.85em' }}>
                                <input
                                  type="checkbox"
                                  checked={(checkedSeasons[i] ?? []).includes(s.seasonNumber)}
                                  onChange={() => toggleSeason(i, s.seasonNumber)}
                                />
                                S{s.seasonNumber}
                              </label>
                            ))}
                        </span>
                      ) : (
                        <span className="placeholder">{r.seasonCount} seasons</span>
                      )}
                      {st === 'adding' && <span className="placeholder">Adding…</span>}
                      {st === 'added' && <span className="badge badge-success">Added — searching</span>}
                      {st === 'already' && <span className="badge badge-warning">Already in library</span>}
                      {st === 'error' && <span className="badge badge-danger">Error</span>}
                      {(st === 'idle' || st === 'error') && (
                        <button
                          className="btn-sm btn-primary"
                          disabled={!!(r.seasons && r.seasons.some((s) => s.seasonNumber >= 1) && !(checkedSeasons[i]?.length))}
                          onClick={() => addSeries(r, i)}
                        >
                          Add
                        </button>
                      )}
                    </div>
                  </div>
```

(This preserves the existing `st` badge logic and the `key={i}`; it only swaps the season display for the checklist and adds the `disabled` gate.)

- [ ] **Step 6: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors; `client/dist` produced. If tsc flags an unused local, remove it.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/TvShowsPage.tsx
git commit -m "feat(client): season checklist in Add Show modal"
```

---

## Chunk 3: Verification and rollout

### Task 3: Verify, merge, USER-RUN live check

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /c/Projects/NGConnect
(cd server && npm test && npm run build) && (cd client && npm run build)
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK" || echo "no embedded keys - good"
```
Expected: server tests pass, both builds exit 0, "no embedded keys - good".

- [ ] **Step 2: Merge and push**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff feature/add-show-seasons -m "feat: pick seasons when adding a show"
git push origin main
```
Expected: push succeeds; server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — add just Season 1**

On the server PC: TV Shows → Add Show → search a multi-season show → uncheck everything except **S1** → Add → confirm in Sonarr that only Season 1 is monitored and only Season 1 searches/downloads.

- [ ] **Step 4: USER-RUN — add all seasons (no regression)**

Add another show with **all** seasons checked (the default) → confirm the whole show is monitored and searched, exactly as before. Also confirm a normal grab from the Search page still auto-adds correctly (the auto-add path shares the changed function).

---

## Done criteria

- [ ] `buildSeriesAddPayload`/`ensureSeries` take `seasons: number[] | null`; both callers (`/add-series`, auto-add) updated; unit tests (season-set cases) pass.
- [ ] Add-Show modal shows a per-season checklist (specials excluded), all checked by default, Add disabled when none checked; posts the selection.
- [ ] Server `tsc` + client `vite` build clean; full suite green; no committed keys.
- [ ] Live check: adding with only S1 monitors/downloads only S1; adding all seasons works as before; Search-page auto-add unaffected.
