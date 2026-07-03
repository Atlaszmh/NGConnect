# Arr History View Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Downloads page's History tab source (empty SAB history) with a durable, combined Sonarr+Radarr history of imported/failed downloads.

**Architecture:** A pure `normalizeArrHistory(radarrRaw, sonarrRaw)` merges the two arrs' `/history` records into one dated `HistoryItem[]` (imported/failed only). A new `GET /api/system/history` fetches both arrs (best-effort, 10s timeout each) and returns `{ items }`. The Downloads History tab renders that; the Queue tab is untouched, with queue and history fetched independently.

**Tech Stack:** Express 5 + TypeScript (server), React 19 + Vite (client), vitest (server, pure-function tests).

**Spec:** [docs/superpowers/specs/2026-07-03-arr-history-view-design.md](../specs/2026-07-03-arr-history-view-design.md)

**Branch:** `feature/arr-history-view` (already checked out). NOT merged to `main` until the end.

---

## File Structure

**New:**
- `server/src/services/arrHistory.ts` — `HistoryItem` type + `normalizeArrHistory` (pure).
- `server/src/services/arrHistory.test.ts` — normalizer unit tests.

**Modified:**
- `server/src/routes/system.ts` — add `GET /history` (fetch both arrs → normalize).
- `client/src/pages/DownloadsPage.tsx` — History tab reads `/system/history`; new table; split queue/history fetches; drop SAB history + Retry.

---

## Chunk 1: Server — normalizer + route

### Task 1: `normalizeArrHistory` (TDD)

**Files:**
- Create: `server/src/services/arrHistory.ts`
- Test: `server/src/services/arrHistory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/arrHistory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeArrHistory } from './arrHistory';

// Minimal records in the documented Radarr/Sonarr /history shape.
function radarrImported(over = {}) {
  return {
    id: 10, movieId: 5, eventType: 'downloadFolderImported',
    sourceTitle: 'The.Matrix.1999.1080p.BluRay.x264-GRP',
    quality: { quality: { name: 'Bluray-1080p' } },
    date: '2026-07-02T10:00:00Z',
    data: { size: '9387696000' },
    movie: { title: 'The Matrix', year: 1999 },
    ...over,
  };
}
function sonarrImported(over = {}) {
  return {
    id: 20, seriesId: 7, episodeId: 99, eventType: 'downloadFolderImported',
    sourceTitle: 'The.Mandalorian.S01E05.1080p.WEB.x264-GRP',
    quality: { quality: { name: 'WEBDL-1080p' } },
    date: '2026-07-03T12:00:00Z',
    data: { size: '2100000000' },
    series: { title: 'The Mandalorian' },
    episode: { seasonNumber: 1, episodeNumber: 5, title: 'Chapter 5' },
    ...over,
  };
}
const wrap = (records: unknown[]) => ({ page: 1, pageSize: 50, totalRecords: records.length, records });

describe('normalizeArrHistory', () => {
  it('maps a Radarr imported movie', () => {
    const [it0] = normalizeArrHistory(wrap([radarrImported()]), null);
    expect(it0).toMatchObject({
      id: 'radarr-10', source: 'radarr', kind: 'movie',
      title: 'The Matrix (1999)', event: 'imported',
      quality: 'Bluray-1080p', sizeBytes: 9387696000, date: '2026-07-02T10:00:00Z',
    });
  });

  it('maps a Sonarr imported episode with SxxExx', () => {
    const [it0] = normalizeArrHistory(null, wrap([sonarrImported()]));
    expect(it0).toMatchObject({
      id: 'sonarr-20', source: 'sonarr', kind: 'tv',
      title: 'The Mandalorian S01E05', event: 'imported', quality: 'WEBDL-1080p',
    });
  });

  it('maps downloadFailed → failed', () => {
    const [it0] = normalizeArrHistory(wrap([radarrImported({ eventType: 'downloadFailed' })]), null);
    expect(it0.event).toBe('failed');
  });

  it('filters out non-import/fail events (grabbed, renames)', () => {
    const items = normalizeArrHistory(
      wrap([radarrImported({ eventType: 'grabbed' }), radarrImported({ eventType: 'movieFileRenamed' })]),
      null
    );
    expect(items).toHaveLength(0);
  });

  it('falls back to sourceTitle and null quality/size on missing fields', () => {
    const rec = { id: 1, eventType: 'downloadFolderImported', sourceTitle: 'Some.Release-GRP', date: '2026-07-01T00:00:00Z' };
    const [it0] = normalizeArrHistory(wrap([rec]), null);
    expect(it0).toMatchObject({ title: 'Some.Release-GRP', quality: null, sizeBytes: null });
  });

  it('merges both arrs sorted newest-first', () => {
    const items = normalizeArrHistory(wrap([radarrImported()]), wrap([sonarrImported()]));
    expect(items.map((i) => i.source)).toEqual(['sonarr', 'radarr']); // sonarr date is newer
  });

  it('returns [] for malformed input', () => {
    expect(normalizeArrHistory(null, null)).toEqual([]);
    expect(normalizeArrHistory({}, 'nope')).toEqual([]);
    expect(normalizeArrHistory({ records: 'x' }, undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run src/services/arrHistory.test.ts`
Expected: FAIL — cannot resolve `./arrHistory`.

- [ ] **Step 3: Implement `arrHistory.ts`**

Create `server/src/services/arrHistory.ts`:

```ts
export interface HistoryItem {
  id: string;                 // `${source}-${record.id}`
  source: 'radarr' | 'sonarr';
  kind: 'movie' | 'tv';
  title: string;
  event: 'imported' | 'failed';
  quality: string | null;
  sizeBytes: number | null;
  date: string;               // ISO; '' if absent
}

type Dict = Record<string, unknown>;

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function recordsOf(raw: unknown): Dict[] {
  if (!raw || typeof raw !== 'object') return [];
  const recs = (raw as Dict).records;
  return Array.isArray(recs) ? (recs as Dict[]) : [];
}

const EVENT_MAP: Record<string, 'imported' | 'failed'> = {
  downloadFolderImported: 'imported',
  downloadFailed: 'failed',
};

function normalizeRecord(rec: Dict, source: 'radarr' | 'sonarr'): HistoryItem | null {
  if (!rec || typeof rec !== 'object') return null;
  const eventType = typeof rec.eventType === 'string' ? rec.eventType : '';
  const event = EVENT_MAP[eventType];
  if (!event) return null; // skip grabbed / renames / deletions / etc.

  const sourceTitle = typeof rec.sourceTitle === 'string' ? rec.sourceTitle : '';
  const qualityObj = rec.quality as Dict | undefined;
  const qualityName = (qualityObj?.quality as Dict | undefined)?.name;
  const quality = typeof qualityName === 'string' ? qualityName : null;
  const data = rec.data && typeof rec.data === 'object' ? (rec.data as Dict) : {};
  const sizeBytes = toInt(data.size);
  const date = typeof rec.date === 'string' ? rec.date : '';
  const id = `${source}-${rec.id ?? ''}`;

  let kind: 'movie' | 'tv';
  let title: string;
  if (source === 'radarr') {
    kind = 'movie';
    const movie = rec.movie as Dict | undefined;
    if (movie && typeof movie.title === 'string') {
      title = typeof movie.year === 'number' ? `${movie.title} (${movie.year})` : movie.title;
    } else {
      title = sourceTitle;
    }
  } else {
    kind = 'tv';
    const series = rec.series as Dict | undefined;
    const ep = rec.episode as Dict | undefined;
    if (series && typeof series.title === 'string') {
      const s = ep?.seasonNumber;
      const e = ep?.episodeNumber;
      const se =
        typeof s === 'number' && typeof e === 'number'
          ? ` S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
          : '';
      title = `${series.title}${se}`;
    } else {
      title = sourceTitle;
    }
  }

  return { id, source, kind, title, event, quality, sizeBytes, date };
}

export function normalizeArrHistory(radarrRaw: unknown, sonarrRaw: unknown): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const rec of recordsOf(radarrRaw)) {
    const it = normalizeRecord(rec, 'radarr');
    if (it) items.push(it);
  }
  for (const rec of recordsOf(sonarrRaw)) {
    const it = normalizeRecord(rec, 'sonarr');
    if (it) items.push(it);
  }
  items.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va; // newest first; unparseable dates sink to the bottom
  });
  return items;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/services/arrHistory.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full suite**

Run: `cd server && npm test`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/arrHistory.ts server/src/services/arrHistory.test.ts
git commit -m "feat(server): add normalizeArrHistory (merge Sonarr+Radarr history)"
```

---

### Task 2: `GET /api/system/history` route

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add the import**

At the top of `server/src/routes/system.ts`, after the other service imports:

```ts
import { normalizeArrHistory } from '../services/arrHistory';
```

- [ ] **Step 2: Add a best-effort fetch helper + the route**

Add near the top of the file (after `export const systemRouter = Router();`):

```ts
// Fetch an arr's recent history; returns null on any error/timeout so one arr
// being down doesn't blank the whole view.
async function fetchArrHistory(
  base: { url: string; apiKey: string },
  includeParams: string
): Promise<unknown> {
  try {
    const url =
      `${base.url}/api/v3/history?page=1&pageSize=50&sortKey=date` +
      `&sortDirection=descending&${includeParams}`;
    const resp = await fetch(url, {
      headers: { 'X-Api-Key': base.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
```

Add the route (e.g. after the `/status` route):

```ts
// Durable download history combined from Sonarr + Radarr (imported/failed).
systemRouter.get('/history', async (_req: Request, res: Response) => {
  const [radarrRaw, sonarrRaw] = await Promise.all([
    fetchArrHistory(config.radarr, 'includeMovie=true'),
    fetchArrHistory(config.sonarr, 'includeSeries=true&includeEpisode=true'),
  ]);
  const items = normalizeArrHistory(radarrRaw, sonarrRaw).slice(0, 50);
  res.json({ items });
});
```

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: `tsc` exit 0.

- [ ] **Step 4: Full suite + confirm route registers**

Run: `cd server && npm test`
Expected: green. (The route's live behavior — real arr history — is the user-run check in Task 5; the meaningful logic is the normalizer, already tested.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): add GET /api/system/history (combined arr history)"
```

---

## Chunk 2: Client — History tab from the arrs

### Task 3: DownloadsPage History tab

**Files:**
- Modify: `client/src/pages/DownloadsPage.tsx`

No client test framework — the build (`npm run build`) is the gate; live render is Task 5.

- [ ] **Step 1: Swap the history type and add formatters**

In `DownloadsPage.tsx`, **replace** the `HistorySlot` interface with:

```tsx
interface HistoryItem {
  id: string;
  source: 'radarr' | 'sonarr';
  kind: 'movie' | 'tv';
  title: string;
  event: 'imported' | 'failed';
  quality: string | null;
  sizeBytes: number | null;
  date: string;
}
```

Add two module-scope helpers next to `formatDownloaded` (these return `--`, unlike SearchPage's `?`):

```tsx
function formatSizeBytes(bytes: number | null): string {
  if (!bytes) return '--';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
function formatAge(dateStr: string): string {
  if (!dateStr) return '--';
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return '--';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day';
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} mths` : `${Math.floor(days / 365)} yrs`;
}
```

- [ ] **Step 2: Split queue and history fetching**

Change `history` state type: `const [history, setHistory] = useState<HistoryItem[]>([]);`

**Replace** the single `fetchData` useCallback with two independent ones (so a history error can't null the queue):

```tsx
  const fetchQueue = useCallback(async () => {
    try {
      const res = await api.get('/sabnzbd/api', { params: { mode: 'queue' } });
      setQueue(res.data?.queue || null);
    } catch {
      setQueue(null);
    }
    setLoading(false);
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await api.get('/system/history');
      setHistory(Array.isArray(res.data?.items) ? res.data.items : []);
    } catch {
      setHistory([]);
    }
  }, []);
```

**Replace** the `useEffect` so only the queue polls every 5s, and history is fetched on mount:

```tsx
  useEffect(() => {
    fetchQueue();
    fetchHistory();
    const interval = setInterval(fetchQueue, 5000);
    return () => clearInterval(interval);
  }, [fetchQueue, fetchHistory]);
```

Update the **Refresh** button to refresh both: `onClick={() => { fetchQueue(); fetchHistory(); }}`.

Update the **History tab** button to refresh history on open: `onClick={() => { setTab('history'); fetchHistory(); }}`.

Update every remaining `fetchData()` call in queue actions (`togglePause`, `deleteItem`) to `fetchQueue()`.

- [ ] **Step 3: Remove the SAB-history Retry path**

Delete the `retryItem` handler entirely (it targeted SAB history).

- [ ] **Step 4: Replace the History table markup**

Replace the entire history-tab render block (the `<div className="history-list">…` branch) with:

```tsx
      ) : (
        <div className="history-list">
          {history.length === 0 ? (
            <p className="placeholder">No download history</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Event</th>
                  <th>Quality</th>
                  <th>Size</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td className="name-cell">{item.title}</td>
                    <td>
                      <span className="badge">{item.kind === 'tv' ? 'TV' : 'Movie'}</span>
                    </td>
                    <td>
                      {item.event === 'imported' ? (
                        <span className="badge badge-success">Imported</span>
                      ) : (
                        <span className="badge badge-danger">
                          <AlertCircle size={12} /> Failed
                        </span>
                      )}
                    </td>
                    <td>{item.quality || '--'}</td>
                    <td>{formatSizeBytes(item.sizeBytes)}</td>
                    <td>{formatAge(item.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
```

(`AlertCircle` stays imported and used here, so no unused-import error. The tab
label `History ({history.length})` is unchanged and works since history is
fetched on mount.)

- [ ] **Step 5: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors. If tsc flags an unused local, it's a leftover from the old SAB-history path (e.g. an unused import or `retryItem`) — remove it.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/DownloadsPage.tsx
git commit -m "feat(client): Downloads History tab shows durable arr history"
```

---

## Chunk 3: Verification and rollout

### Task 4: Full local verification

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

### Task 5: Merge to main, then USER-RUN live check on the server PC

The arr `/history` is `localhost`-only — the real render is a server-PC check. Merging to `main` deploys it there.

- [ ] **Step 1: Merge and push**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff feature/arr-history-view -m "feat: Downloads History shows durable Sonarr/Radarr history"
git push origin main
```
Expected: push succeeds; server PC auto-deploys within the hour (or via "Check for Updates Now"). (Note: this also pushes the previously-unpushed add-to-library spec commits, as the user OK'd.)

- [ ] **Step 2: USER-RUN — the durable history renders**

On the server PC: Downloads → **History** tab. Confirm it now lists real recent imports from Sonarr/Radarr — Title, Type (TV/Movie), Event (Imported/Failed), Quality, Size, Age — including a known recent import (e.g. the earlier auto-add test). Confirm the **Queue** tab still works (live downloads, pause/reorder/delete).

- [ ] **Step 3: USER-RUN — check Size, and capture a fixture if it's off**

Look at the **Size** column. If sizes show `--` for items that clearly have a size, the arr puts the byte count somewhere other than `data.size`. Grab one real Sonarr and one real Radarr `/history` JSON response (Activity → History, or `GET /api/v3/history` — nothing secret in it) and send it over; I'll pin the real field and add a fixture-backed regression test (per the spec's recommended follow-up).

- [ ] **Step 4: USER-RUN — one arr down is graceful (optional)**

If convenient, confirm that with one arr briefly unreachable the History tab still shows the other arr's items rather than going blank.

---

## Done criteria

- [ ] `normalizeArrHistory` merges/normalizes/sorts imported+failed records; unit tests pass in `npm test`.
- [ ] `GET /api/system/history` returns `{ items }`, best-effort per arr (10s timeout), one-arr-down safe.
- [ ] Downloads History tab renders the combined arr history (Title/Type/Event/Quality/Size/Age); Queue tab unchanged; queue and history fetch independently.
- [ ] Server `tsc` + client `vite` build clean; no committed keys.
- [ ] Live check on the server PC: History shows real recent imports; Queue still works.
