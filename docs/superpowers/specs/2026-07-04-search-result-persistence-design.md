# Search-Result Persistence — Design Spec

**Date:** 2026-07-04
**Status:** Proposed (planned unattended — decisions flagged for Zach's review)
**Author:** Claude (for Zach)

> **Note:** Zach asked me to design + plan this while away, so I made the calls
> below myself. Each **Decision** line marks a choice you may want to change on
> review; everything else follows from them.

## Problem

The Search page loses everything the moment you navigate away. All of its state —
the query, category filter, results, sort, and per-row grab outcomes — lives in
local `useState` in `client/src/pages/SearchPage.tsx`, so React unmounts the
component on route change and the results are gone. Coming back means re-typing
and re-searching. The goal: keep the Search page's state for the browser session,
so navigating away and back restores exactly what you left.

## Goals

- After a search, navigating to another page and back to Search **restores the
  query, category, results, sort, and grab outcomes** without re-querying NZBGeek.
- Survives an accidental **page reload** within the same tab/session.
- Zero server changes; no new dependencies; self-contained to the Search page.

## Non-Goals

- Persisting the **Add Show / Add Movie** search modals (those are transient
  lookups on the TV/Movies pages — out of scope).
- **Cross-tab or cross-session** persistence (sessionStorage is deliberately
  per-tab and clears when the tab closes — see Decision 1).
- Server-side or account-level saved searches / history.
- Re-running the search automatically on restore (we restore the *stored*
  results, we don't re-fetch).

## Decisions (made unattended — change any on review)

- **Decision 1 — store: `sessionStorage`.** It survives client-side navigation
  AND a full page reload, and clears when the tab/session ends — which matches
  "keep it for a session." Alternatives considered: a module-level in-memory cache
  (lost on reload) and `localStorage` (persists forever across sessions — more than
  asked). If you'd rather it survive browser restarts, switch to `localStorage`;
  if you'd rather it vanish on reload, a module cache.
- **Decision 2 — persist the grab outcomes too.** The per-row grab state
  (`grabbed`/`rejected`/`error` + message) is restored so you can see what you
  already sent. Any in-flight `sending` state is sanitized to `idle` on restore
  (no request is actually in flight after a remount). If you'd rather grab
  outcomes reset on navigation, drop this from the persisted set — it's isolated.
- **Decision 3 — restore the stored results as-is** (no background refresh).
  NZBGeek results don't change second-to-second; a stale-on-return list is
  acceptable and cheaper than a silent re-query. The user can hit Search again to
  refresh.

## Context (current state)

`client/src/pages/SearchPage.tsx` holds all state in local `useState`:
`query`, `category`, `results: NzbResult[]`, `searching`, `sortKey`,
`sortDir`, and `grab: Record<string, {state, msg?}>`. `results` rows each carry a
`rowId` (`\`${guid}#${i}\``) that keys the `grab` map, so results + grab must be
persisted **together** to stay consistent. `searching` is transient (never
persisted). There is **no client test harness** (server-only vitest) — the client
`npm run build` is the automated gate; behavior is user-verified.

## Architecture Overview

A tiny persistence helper + minimal wiring in `SearchPage.tsx`. One serializable
"snapshot" of the persistable state is written to `sessionStorage` whenever it
changes and read back once on mount. Keep the helper pure and separate so the
page component stays readable.

## Component 1: `client/src/services/searchPersistence.ts` (new)

A small module owning the storage key, the snapshot shape, and safe load/save.

```ts
export interface SearchSnapshot {
  query: string;
  category: string;
  results: NzbResult[];               // import the type from SearchPage or a shared types file
  sortKey: SortKey | null;
  sortDir: SortDir;
  grab: Record<string, { state: GrabState; msg?: string }>;
}
```

- `STORAGE_KEY = 'ngconnect:search:v1'` (versioned so a future shape change can be
  ignored cleanly rather than crashing).
- `loadSearchSnapshot(): SearchSnapshot | null` — `sessionStorage.getItem` →
  `JSON.parse` → basic shape guard (results is an array, etc.); on anything
  missing/invalid/throwing, return `null`. **Sanitize:** any `grab` entry whose
  `state === 'sending'` is coerced to `{ state: 'idle' }`.
- `saveSearchSnapshot(s: SearchSnapshot): void` — `JSON.stringify` →
  `sessionStorage.setItem`, wrapped in `try/catch` (a quota/serialization error
  must never break the page; just skip persisting).

To avoid a circular import, the shared types (`NzbResult`, `SortKey`, `SortDir`,
`GrabState`) move to a small `client/src/pages/searchTypes.ts` (or are imported by
the helper from `SearchPage` if the planner prefers — the plan will pick the
cleaner boundary; extracting the types is the tidier option).

## Component 2: `SearchPage.tsx` wiring

- **On mount:** read `loadSearchSnapshot()` once (a `useState` lazy initializer or
  a top-of-component `const snap = useMemo(loadSearchSnapshot, [])`) and seed
  `query`/`category`/`results`/`sortKey`/`sortDir`/`grab` from it (falling back to
  today's defaults when `null`).
- **On change:** a single `useEffect` with deps `[query, category, results,
  sortKey, sortDir, grab]` calls `saveSearchSnapshot({...})`. (Writing on every
  keystroke of `query` is fine — sessionStorage writes are cheap and synchronous;
  if we want to be tidy the plan may debounce, but YAGNI for a local dashboard.)
- `searching` stays purely local (never persisted).

## Data Flow

Search → results land in state → `useEffect` writes the snapshot to sessionStorage
→ user navigates away (component unmounts, snapshot remains) → returns to Search →
mount reads the snapshot → state seeded → the existing render shows the restored
query/results/sort/grab. Grab a row → `grab` map updates → snapshot rewritten.

## Error Handling

| Case | Behavior |
|---|---|
| No stored snapshot | `load` returns `null` → page starts with today's empty defaults. |
| Corrupt/invalid JSON or wrong shape | `load` returns `null` (guarded) → fresh start; the bad key is harmless (overwritten on next search). |
| `sessionStorage` unavailable / quota exceeded | `save` swallows the error; the page works, just doesn't persist that write. |
| A `grab` row was mid-`sending` at unmount | restored as `idle` (re-grabbable), never stuck on "Sending…". |

## Testing Strategy

- **Automated gate:** `cd client && npm run build` (tsc -b && vite build) — strict
  TS clean (`noUnusedLocals`, `verbatimModuleSyntax`; the moved types must be
  imported as `import type` where used only as types).
- **USER-RUN (the real check):** search NZBGeek → navigate to another page →
  return to Search and confirm query, category, results, and sort are intact;
  grab a row, navigate away and back, confirm the grabbed/rejected badge persists;
  reload the tab and confirm state survives; open Search in a **new tab** and
  confirm it starts fresh (per-tab). No live arr/SAB dependency — this is
  browser-only, so it can be checked on the dev PC too.

## Risks / Open Questions

- **Snapshot size.** A large NZBGeek result set (many rows × several fields) is
  still comfortably within sessionStorage's ~5MB budget; `save`'s `try/catch`
  covers the pathological case. No pruning needed for v1.
- **Type-boundary choice** (extract `searchTypes.ts` vs import from `SearchPage`)
  is a tidiness decision the plan will lock; both compile.
- **Grab-outcome staleness:** a restored `grabbed` badge reflects the earlier
  session action, not a live re-check — acceptable and expected (Decision 2/3).

## Files Touched

**New:**
- `client/src/services/searchPersistence.ts` — snapshot type + `load`/`save`.
- `client/src/pages/searchTypes.ts` — shared `NzbResult`/`SortKey`/`SortDir`/
  `GrabState` types (if the planner extracts them; otherwise the helper imports
  from `SearchPage`).
- `docs/superpowers/specs/2026-07-04-search-result-persistence-design.md` (this).

**Modified:**
- `client/src/pages/SearchPage.tsx` — seed state from the snapshot on mount; write
  the snapshot on change.
