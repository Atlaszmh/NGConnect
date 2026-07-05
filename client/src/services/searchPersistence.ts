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
