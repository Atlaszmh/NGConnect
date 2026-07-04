# Search-Result Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Search page's state (query, category, results, sort, grab outcomes) alive for the browser session so navigating away and back restores it.

**Architecture:** Extract the Search page's shared types into `searchTypes.ts`, add a tiny `searchPersistence.ts` helper that reads/writes a `SearchSnapshot` to `sessionStorage` (sanitizing any in-flight `sending` grab to `idle` on load), then seed `SearchPage` state from the snapshot on mount and re-save on change.

**Tech Stack:** React 19 + Vite + TypeScript (strict, `noUnusedLocals`, `verbatimModuleSyntax`). No client test harness — `cd client && npm run build` (tsc -b && vite build) is the only automated gate; behavior is verified by a USER-RUN browser check.

**Spec:** [docs/superpowers/specs/2026-07-04-search-result-persistence-design.md](../specs/2026-07-04-search-result-persistence-design.md)

**Branch:** `feature/search-persistence` (already checked out). NOT merged to `main` until the end.

---

## Note on testing (read first)

Client-only feature; there is NO client unit-test harness (vitest is server-only) and `sessionStorage` behavior is browser-runtime. Do NOT add a test framework — that's out of scope. Each task's automated gate is `cd client && npm run build`. The real verification is the USER-RUN browser check in the final task.

---

## File Structure

**New:**
- `client/src/pages/searchTypes.ts` — the shared types (`NzbResult`, `SortKey`, `SortDir`, `GrabState`) moved out of `SearchPage.tsx` and exported, so both the page and the persistence helper can import them without a circular dependency.
- `client/src/services/searchPersistence.ts` — `SearchSnapshot` type + `loadSearchSnapshot()` / `saveSearchSnapshot()` (safe `sessionStorage` I/O + `sending`→`idle` sanitize).

**Modified:**
- `client/src/pages/SearchPage.tsx` — import the moved types (`import type`), seed the six persistable states from the snapshot on mount, and save the snapshot on change.

---

## Chunk 1: Persistence end-to-end

### Task 1: Extract shared types into `searchTypes.ts`

**Files:**
- Create: `client/src/pages/searchTypes.ts`
- Modify: `client/src/pages/SearchPage.tsx`

- [ ] **Step 1: Create `client/src/pages/searchTypes.ts`**

```ts
export interface NzbResult {
  guid: string;
  rowId: string;
  title: string;
  link: string;
  category: string;
  categoryId: number | null;
  sizeBytes: number;
  pubDate: string;
  grabs: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
}

export type SortKey = 'title' | 'category' | 'pubDate' | 'sizeBytes' | 'grabs';
export type SortDir = 'asc' | 'desc';
export type GrabState = 'idle' | 'sending' | 'grabbed' | 'rejected' | 'error';
```

- [ ] **Step 2: Remove the in-file type declarations from `SearchPage.tsx` and import them**

In `SearchPage.tsx`:
- DELETE the `interface NzbResult { … }` block (currently lines 5-19), the `type SortKey = …` and `type SortDir = …` lines (21-22), and the `type GrabState = …` line (116).
- Add, alongside the existing imports at the top of the file:

```ts
import type { NzbResult, SortKey, SortDir, GrabState } from './searchTypes';
```

(Use `import type` — these are used only as types in `SearchPage`, which `verbatimModuleSyntax` requires. Everything else in the file — `CATEGORIES`, `sortResults`, `bandTarget`, `interpretPush`, the component — stays put and continues to reference the now-imported types.)

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors (no "duplicate identifier", no unused-import); `client/dist` produced.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/searchTypes.ts client/src/pages/SearchPage.tsx
git commit -m "refactor(client): extract Search page shared types into searchTypes.ts"
```

---

### Task 2: The `searchPersistence.ts` helper

**Files:**
- Create: `client/src/services/searchPersistence.ts`

- [ ] **Step 1: Create `client/src/services/searchPersistence.ts`**

```ts
import type { NzbResult, SortKey, SortDir, GrabState } from '../pages/searchTypes';

export interface SearchSnapshot {
  query: string;
  category: string;
  results: NzbResult[];
  sortKey: SortKey | null;
  sortDir: SortDir;
  grab: Record<string, { state: GrabState; msg?: string }>;
}

const STORAGE_KEY = 'ngconnect:search:v1';

// Read the session snapshot. Returns null on missing/corrupt/invalid data so the
// page falls back to empty defaults. An in-flight 'sending' grab is coerced to
// 'idle' — no request survives a component remount, so a persisted 'sending'
// must not leave a row stuck on "Sending…".
export function loadSearchSnapshot(): SearchSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SearchSnapshot>;
    if (!parsed || !Array.isArray(parsed.results)) return null;

    const grab: Record<string, { state: GrabState; msg?: string }> = {};
    const rawGrab =
      parsed.grab && typeof parsed.grab === 'object' ? parsed.grab : {};
    for (const [key, value] of Object.entries(rawGrab)) {
      if (value && typeof value === 'object') {
        const state = (value as { state?: GrabState }).state;
        const msg = (value as { msg?: string }).msg;
        grab[key] = { state: !state || state === 'sending' ? 'idle' : state, msg };
      }
    }

    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      category: typeof parsed.category === 'string' ? parsed.category : '',
      results: parsed.results as NzbResult[],
      sortKey: (parsed.sortKey ?? null) as SortKey | null,
      sortDir: parsed.sortDir === 'asc' ? 'asc' : 'desc',
      grab,
    };
  } catch {
    return null;
  }
}

// Persist the snapshot. Any failure (quota, serialization) is swallowed — never
// break the page over a failed persist.
export function saveSearchSnapshot(snapshot: SearchSnapshot): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* skip persisting */
  }
}
```

- [ ] **Step 2: Build**

Run: `cd client && npm run build`
Expected: build clean; `client/dist` produced. (The helper isn't imported yet, but it must typecheck.)

- [ ] **Step 3: Commit**

```bash
git add client/src/services/searchPersistence.ts
git commit -m "feat(client): sessionStorage helper for Search snapshot (load/save + sanitize)"
```

---

### Task 3: Wire `SearchPage` to the snapshot

**Files:**
- Modify: `client/src/pages/SearchPage.tsx`

- [ ] **Step 1: Import the helper + `useEffect`**

At the top of `SearchPage.tsx`:
- Change the React import to include `useEffect`:

```ts
import { useState, useMemo, useEffect } from 'react';
```

- Add:

```ts
import { loadSearchSnapshot, saveSearchSnapshot } from '../services/searchPersistence';
```

- [ ] **Step 2: Seed state from the snapshot on mount**

Replace the existing state declarations (currently `SearchPage.tsx:119-125`):

```tsx
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<NzbResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [grab, setGrab] = useState<Record<string, { state: GrabState; msg?: string }>>({});
```

with (read the snapshot once, seed each state from it):

```tsx
  const initial = useMemo(() => loadSearchSnapshot(), []);
  const [query, setQuery] = useState(initial?.query ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [results, setResults] = useState<NzbResult[]>(initial?.results ?? []);
  const [searching, setSearching] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(initial?.sortKey ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(initial?.sortDir ?? 'desc');
  const [grab, setGrab] = useState<Record<string, { state: GrabState; msg?: string }>>(
    initial?.grab ?? {},
  );
```

- [ ] **Step 3: Save the snapshot on change**

Add a `useEffect` right after the state declarations (and after the `setRow` helper, anywhere inside the component before the return):

```tsx
  // Persist the search for the session so navigating away and back restores it.
  // Fires once on mount too (re-writing the just-loaded snapshot) — intentional
  // and harmless; do not add a skip-first-render guard.
  useEffect(() => {
    saveSearchSnapshot({ query, category, results, sortKey, sortDir, grab });
  }, [query, category, results, sortKey, sortDir, grab]);
```

- [ ] **Step 4: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors (`useEffect`/`useMemo`/`initial` all used; `import type` satisfies `verbatimModuleSyntax`); `client/dist` produced.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SearchPage.tsx
git commit -m "feat(client): persist + restore Search page state across navigation"
```

---

## Chunk 2: Verification and rollout

### Task 4: Verify, merge, USER-RUN check

- [ ] **Step 1: Full build**

Run: `cd /c/Projects/NGConnect/client && npm run build`
Expected: exits 0, `client/dist` produced, no type errors. (No server changes; `git diff --stat main..HEAD` should show only `client/src/pages/searchTypes.ts`, `client/src/services/searchPersistence.ts`, `client/src/pages/SearchPage.tsx`, and the two docs.)

- [ ] **Step 2: Confirm no divergence, then merge and push**

```bash
cd /c/Projects/NGConnect
git fetch origin
git log --oneline HEAD..origin/main   # expect EMPTY
git checkout main
git merge --ff-only origin/main
git merge --no-ff feature/search-persistence -m "feat: persist Search page results across navigation for the session"
(cd client && npm run build) && git push origin main
```
Expected: `HEAD..origin/main` empty; merged build clean; push succeeds. Server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — browser check** (no arr/SAB dependency; works on the dev PC too)

- Search NZBGeek, apply a sort, navigate to another page (e.g. Dashboard), return to Search → query, category, results, and sort are all restored (no re-query).
- Grab a row (or trigger a rejection), navigate away and back → the grabbed/rejected badge is still shown.
- Reload the tab → state survives.
- Open Search in a **new browser tab** → it starts fresh (sessionStorage is per-tab).
- A row that was mid-"Sending…" when you navigated away comes back as a normal grabbable row (not a stuck spinner).

---

## Done criteria

- [ ] Shared types live in `searchTypes.ts`; `SearchPage` imports them as `import type`; no duplicate declarations.
- [ ] `searchPersistence.ts` safely loads/saves the snapshot and sanitizes `sending`→`idle`; all I/O is `try/catch`-guarded.
- [ ] `SearchPage` seeds state from the snapshot on mount and saves on change; `searching` stays transient.
- [ ] Client build clean; merged to main and pushed.
- [ ] Live check: navigate-away-and-back and reload restore the search; new tab is fresh.
