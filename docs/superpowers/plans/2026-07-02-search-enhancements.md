# Search Enhancements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual Search page show sortable Name/Category/Age/Size/Grabs columns, and route the "grab" action through Sonarr/Radarr (`release/push`) so downloads auto-import and refresh Plex instead of piling up untracked in SABnzbd.

**Architecture:** A pure server function `parseNewznabResults` normalizes NZBGeek's `extended=1` Newznab JSON into a typed `NzbResult[]`; the `/search` route returns `{ results }`. A new `POST /nzbgeek/send-to-arr` hands a release to Sonarr/Radarr (NZBGeek key injected server-side) and passes the arr's decision back. SearchPage renders sortable columns (client-side sort) and routes grabs by category band, showing Grabbed/Rejected/Error per row.

**Tech Stack:** Express 5 + TypeScript (server), React 19 + Vite + TypeScript (client), vitest (server, pure-function tests), plain `fetch` for upstreams.

**Spec:** [docs/superpowers/specs/2026-07-02-search-enhancements-design.md](../specs/2026-07-02-search-enhancements-design.md)

**Branch:** work happens on `feature/search-enhancements` (already created and checked out). It is NOT merged to `main` until the end, so nothing auto-deploys to the server PC mid-change.

---

## File Structure

**New:**
- `server/src/services/newznab.ts` — `NzbResult` type + `parseNewznabResults` (pure).
- `server/src/services/newznab.test.ts` — parser unit tests (synthetic + real fixture).
- `server/src/services/__fixtures__/nzbgeek-search.json` — a real captured NZBGeek `extended=1` response with all API keys redacted. **Controller-provided** (see Task 1) because it derives from a live key that must not pass through a subagent.

**Modified:**
- `server/src/routes/nzbgeek.ts` — `/search` adds `extended=1`, returns `{ results }`, `limit` 50→100; new `POST /send-to-arr`; `send-to-sab` untouched.
- `client/src/pages/SearchPage.tsx` — consume `results`; sortable columns; arr-routed grab + feedback.

**Untouched (referenced):** `server/src/config.ts` (`config.sonarr/radarr/nzbgeek`), `server/src/services/proxy.ts`, `client/src/services/api.ts`.

---

## Chunk 1: Server — Newznab parser + search route

### Task 1: Add the real captured test fixture (controller-prepared)

**Files:**
- Create: `server/src/services/__fixtures__/nzbgeek-search.json`

The fixture is a real NZBGeek `t=search&extended=1&o=json` response captured during design, with **every `apikey` value redacted** — the key appears inside each item's `link` and `enclosure["@attributes"].url` (Newznab embeds `&apikey=`). **This file is already created and committed by the controller** (commit `ff0bcca`) from the captured response, replacing every `apikey=<value>` with `apikey=REDACTED`, since the raw capture contains the live key and must not be handled by a subagent. This task is therefore verification-only.

- [ ] **Step 1: Verify the fixture exists, is valid JSON, and is key-free**

Run:
```bash
cd /c/Projects/NGConnect
test -f server/src/services/__fixtures__/nzbgeek-search.json && echo "fixture present" || echo "MISSING"
node -e "JSON.parse(require('fs').readFileSync('server/src/services/__fixtures__/nzbgeek-search.json','utf-8')); console.log('valid JSON')"
# Leak check: find any apikey= value that is NOT the REDACTED placeholder.
# (Do NOT use `grep -i ... [a-z0-9]{8,}` — case-insensitive matches the word REDACTED and false-positives.)
grep -oE "apikey=[^&\"]+" server/src/services/__fixtures__/nzbgeek-search.json | grep -v "apikey=REDACTED" && echo "LEAK: real key present" || echo "no real key - good"
```
Expected: "fixture present", "valid JSON", and "no real key - good" (the leak grep prints nothing and the `||` branch fires).

---

### Task 2: `parseNewznabResults` + `NzbResult` (TDD)

**Files:**
- Create: `server/src/services/newznab.ts`
- Test: `server/src/services/newznab.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/newznab.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseNewznabResults } from './newznab';

// Minimal Newznab item in the REAL shape: attrs nested under @attributes.
function item(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Show.Name.S01E01.1080p.WEB.x264-GRP',
    guid: 'abc123',
    link: 'https://api.nzbgeek.info/api?t=get&id=abc123&apikey=REDACTED',
    enclosure: { '@attributes': { url: 'https://x/nzb', length: '1500000000', type: 'application/x-nzb' } },
    attr: [
      { '@attributes': { name: 'category', value: '5000' } },
      { '@attributes': { name: 'category', value: '5040' } },
      { '@attributes': { name: 'size', value: '1500000000' } },
      { '@attributes': { name: 'grabs', value: '42' } },
      { '@attributes': { name: 'usenetdate', value: 'Mon, 29 Jun 2026 15:22:00 +0000' } },
    ],
    ...overrides,
  };
}

describe('parseNewznabResults — core shape', () => {
  it('reads @attributes-nested attrs (grabs/size), most-specific categoryId, usenetdate', () => {
    const [r] = parseNewznabResults({ channel: { item: [item()] } });
    expect(r.title).toBe('Show.Name.S01E01.1080p.WEB.x264-GRP');
    expect(r.guid).toBe('abc123');
    expect(r.sizeBytes).toBe(1500000000);
    expect(r.grabs).toBe(42);
    expect(r.categoryId).toBe(5040); // most specific of 5000/5040
    expect(r.pubDate).toBe('Mon, 29 Jun 2026 15:22:00 +0000'); // usenetdate wins
  });

  it('handles a single item object (not an array)', () => {
    expect(parseNewznabResults({ channel: { item: item() } })).toHaveLength(1);
  });

  it('handles a single attr object (not an array)', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: { '@attributes': { name: 'grabs', value: '7' } } })] },
    });
    expect(r[0].grabs).toBe(7);
  });

  it('missing grabs -> null (not 0)', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: [{ '@attributes': { name: 'size', value: '10' } }] })] },
    });
    expect(r[0].grabs).toBeNull();
  });

  it('size falls back to enclosure length when no size attr', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: [{ '@attributes': { name: 'grabs', value: '1' } }] })] },
    });
    expect(r[0].sizeBytes).toBe(1500000000);
  });

  it('skips items with neither guid nor link', () => {
    const r = parseNewznabResults({ channel: { item: [item({ guid: '', link: '' })] } });
    expect(r).toHaveLength(0);
  });

  it('malformed input -> [] (never throws)', () => {
    expect(parseNewznabResults(null)).toEqual([]);
    expect(parseNewznabResults('nope')).toEqual([]);
    expect(parseNewznabResults({})).toEqual([]);
    expect(parseNewznabResults({ channel: {} })).toEqual([]);
  });
});

describe('parseNewznabResults — against the REAL captured fixture', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8')
  );
  const results = parseNewznabResults(raw);

  it('extracts a non-empty result set', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('every result has the required fields well-typed', () => {
    for (const r of results) {
      expect(typeof r.guid).toBe('string');
      expect(r.guid.length).toBeGreaterThan(0);
      expect(typeof r.title).toBe('string');
      expect(typeof r.sizeBytes).toBe('number');
      expect(r.grabs === null || typeof r.grabs === 'number').toBe(true);
      expect(r.categoryId === null || typeof r.categoryId === 'number').toBe(true);
    }
  });

  it('REGRESSION: the @attributes-nested read actually populates grabs + size (the bug the flat shape would cause)', () => {
    // At least one real result must have a real grabs number and a real size,
    // proving we read attr[i]["@attributes"], not a flat attr[i].name.
    expect(results.some((r) => typeof r.grabs === 'number' && r.grabs >= 0)).toBe(true);
    expect(results.every((r) => r.sizeBytes > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/newznab.test.ts`
Expected: FAIL — cannot resolve `./newznab`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/newznab.ts`:

```ts
export interface NzbResult {
  guid: string;
  title: string;
  link: string;
  category: string;        // best-effort raw text (may be ''); client maps categoryId -> label
  categoryId: number | null; // primary numeric Newznab category code (most specific), for routing
  sizeBytes: number;       // 0 if unknown
  pubDate: string;         // original date string; '' if unknown
  grabs: number | null;    // null if absent
}

function asString(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o['#text'] === 'string') return o['#text'];
  }
  return '';
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

interface Attrs {
  first: Map<string, string>; // first value seen per attr name
  categories: number[];       // all numeric category codes
}

function readAttrs(item: Record<string, unknown>): Attrs {
  const first = new Map<string, string>();
  const categories: number[] = [];
  let attr = item.attr as unknown;
  if (attr && !Array.isArray(attr)) attr = [attr];
  if (Array.isArray(attr)) {
    for (const el of attr) {
      if (!el || typeof el !== 'object') continue;
      const rec = el as Record<string, unknown>;
      // Real NZBGeek shape: { "@attributes": { name, value } }. Flat fallback as insurance.
      const a = (rec['@attributes'] as Record<string, unknown> | undefined) ?? rec;
      const name = typeof a.name === 'string' ? a.name : undefined;
      if (!name) continue;
      const value = a.value;
      const valStr = typeof value === 'string' ? value : value == null ? '' : String(value);
      if (!first.has(name)) first.set(name, valStr);
      if (name === 'category') {
        const n = toInt(valStr);
        if (n !== null) categories.push(n);
      }
    }
  }
  return { first, categories };
}

function sizeOf(item: Record<string, unknown>, attrs: Attrs): number {
  const enc = item.enclosure as Record<string, unknown> | undefined;
  const encAttrs = (enc?.['@attributes'] as Record<string, unknown> | undefined) ?? enc;
  const fromEnc = toInt(encAttrs?.length);
  if (fromEnc !== null && fromEnc > 0) return fromEnc;
  const fromAttr = toInt(attrs.first.get('size'));
  if (fromAttr !== null && fromAttr > 0) return fromAttr;
  const fromItem = toInt(item.size);
  return fromItem !== null && fromItem > 0 ? fromItem : 0;
}

export function parseNewznabResults(raw: unknown): NzbResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const channel = r.channel as Record<string, unknown> | undefined;
  let items = channel?.item ?? r.item;
  if (items && !Array.isArray(items)) items = [items];
  if (!Array.isArray(items)) return [];

  const results: NzbResult[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const attrs = readAttrs(item);

    const link = asString(item.link);
    const guid = asString(item.guid) || link;
    if (!guid && !link) continue;

    results.push({
      guid,
      title: asString(item.title),
      link,
      category: asString(item.category),
      categoryId: attrs.categories.length ? Math.max(...attrs.categories) : null,
      sizeBytes: sizeOf(item, attrs),
      pubDate: attrs.first.get('usenetdate') ?? asString(item.pubDate),
      grabs: toInt(attrs.first.get('grabs')),
    });
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/newznab.test.ts`
Expected: PASS (all cases, incl. the fixture regression test).

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — existing suites plus the new newznab tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/newznab.ts server/src/services/newznab.test.ts
git commit -m "feat(server): add parseNewznabResults with real-shape fixture tests"
```

---

### Task 3: `/search` route — `extended=1`, `{ results }`, limit 100

**Files:**
- Modify: `server/src/routes/nzbgeek.ts`

- [ ] **Step 1: Update the /search handler**

In `server/src/routes/nzbgeek.ts`, add the import at the top:

```ts
import { parseNewznabResults } from '../services/newznab';
```

Change the default limit and add `extended`, then normalize the response. In the `/search` handler, set `limit = '100'` as the default, and after building the URL add:

```ts
  url.searchParams.set('extended', '1'); // REQUIRED: grabs/usenetdate are only returned with extended=1
```

In the **`/search` handler only** (the `res.json(data);` on ~line 30 — NOT the
identical line in `/send-to-sab` at ~line 88), replace the success line with:

```ts
    res.json({ results: parseNewznabResults(data) });
```

(The `limit` default: change `const { q, cat, limit = '50' } = req.query;` to `limit = '100'`.)

- [ ] **Step 2: Build to confirm compilation**

Run: `cd server && npm run build`
Expected: `tsc` exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/nzbgeek.ts
git commit -m "feat(server): /search returns normalized results with extended=1"
```

---

## Chunk 2: Server — arr-routed grab endpoint

### Task 4: `POST /nzbgeek/send-to-arr`

**Files:**
- Modify: `server/src/routes/nzbgeek.ts`

- [ ] **Step 1: Add the endpoint**

In `server/src/routes/nzbgeek.ts`, add after the existing `send-to-sab` route:

```ts
// Hand a release to Sonarr/Radarr via release/push so their Completed Download
// Handling imports it (and Plex refreshes). Keeps all API keys server-side.
nzbgeekRouter.post('/send-to-arr', async (req: Request, res: Response) => {
  const { title, nzbUrl, pubDate, target } = req.body ?? {};

  // Guard for STRINGS (not just truthy): downloadUrl is built outside the
  // try/catch below, so a non-string nzbUrl would throw an unhandled 500 on
  // `.includes`. Mirrors /search's `typeof q !== 'string'` check.
  if (typeof nzbUrl !== 'string' || !nzbUrl || typeof title !== 'string' || !title) {
    res.status(400).json({ error: 'title and nzbUrl (strings) are required' });
    return;
  }
  if (target !== 'sonarr' && target !== 'radarr') {
    res.status(400).json({ error: "target must be 'sonarr' or 'radarr'" });
    return;
  }

  const base = target === 'sonarr' ? config.sonarr : config.radarr;

  // Append the NZBGeek API key server-side (same rule as send-to-sab).
  const downloadUrl = nzbUrl.includes('apikey')
    ? nzbUrl
    : `${nzbUrl}&apikey=${config.nzbgeek.apiKey}`;

  const payload = {
    title,
    downloadUrl,
    protocol: 'usenet', // current Sonarr/Radarr v3 value; verified only via the live grab test
    publishDate: pubDate || new Date().toISOString(),
  };

  try {
    const response = await fetch(`${base.url}/api/v3/release/push`, {
      method: 'POST',
      headers: { 'X-Api-Key': base.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Pass the arr's status + body straight through so the UI can read the decision.
    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);
    if (contentType.includes('application/json')) {
      res.json(await response.json());
    } else {
      res.send(await response.text());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`send-to-arr [${target}] error:`, message);
    res.status(502).json({ error: `Could not connect to ${target}` });
  }
});
```

- [ ] **Step 2: Build to confirm compilation**

Run: `cd server && npm run build`
Expected: `tsc` exits 0.

- [ ] **Step 3: Confirm the route registers (no separate runtime check here)**

The input-validation branches (missing `title`/`nzbUrl`, bad `target`) are simple
guards verified by reading the code; the arr-connected path can only be exercised
on the server PC (Task 8), since the arrs are `localhost`-only. So there is no
meaningful local runtime test for this route beyond the successful build in
Step 2 — do not add a fake "no crash" check that would falsely imply verification.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/nzbgeek.ts
git commit -m "feat(server): add /nzbgeek/send-to-arr (release/push to Sonarr/Radarr)"
```

---

## Chunk 3: Client — sortable columns + arr-routed grab

### Task 5: Consume `{ results }` and add sortable columns

**Files:**
- Modify: `client/src/pages/SearchPage.tsx`

No client test framework exists; verification is `npm run build` (typecheck) + the manual/live check in Task 8.

> **IMPORTANT — build/commit only once, after Task 6.** Task 5 and Task 6 both
> rewrite the SAME file (`SearchPage.tsx`) and only compile together (Task 5
> removes cells/state that Task 6's code replaces). Do **not** run `npm run
> build` or commit at the end of Task 5. The single build gate and single commit
> are Task 6 Steps 4–5.

- [ ] **Step 1: Update imports, result type, and search parsing**

At the top of `SearchPage.tsx`, first **remove the now-unused `Send` icon** from
the lucide import (it was only used by the old SABnzbd button; `noUnusedLocals`
will fail the build otherwise). Change `import { Search, Send } from 'lucide-react';`
to `import { Search } from 'lucide-react';`.

Then replace the `NzbResult` interface with the new shape and a sort type:

```tsx
interface NzbResult {
  guid: string;
  title: string;
  link: string;
  category: string;
  categoryId: number | null;
  sizeBytes: number;
  pubDate: string;
  grabs: number | null;
}

type SortKey = 'title' | 'category' | 'pubDate' | 'sizeBytes' | 'grabs';
type SortDir = 'asc' | 'desc';
```

In `doSearch`, replace the Newznab-shape guessing with:

```tsx
      const res = await api.get('/nzbgeek/search', {
        params: { q: query, cat: category || undefined },
      });
      setResults(Array.isArray(res.data?.results) ? res.data.results : []);
```

(The server now adds `extended=1` and `limit=100`; the client passes only `q`/`cat`.)

- [ ] **Step 2: Add sort state + a pure sort helper + category label**

Inside the component, add:

```tsx
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const clickSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // text asc first; numeric (size/grabs/age) desc first
      setSortDir(key === 'title' || key === 'category' ? 'asc' : 'desc');
    }
  };
```

Above the component (module scope), add the label map and helpers:

```tsx
const CATEGORY_LABELS: Record<number, string> = {
  2000: 'Movies', 2040: 'Movies - HD', 2045: 'Movies - UHD', 2030: 'Movies - SD',
  2050: 'Movies - BluRay', 2060: 'Movies - 3D',
  5000: 'TV', 5040: 'TV - HD', 5045: 'TV - UHD', 5030: 'TV - SD',
  3000: 'Audio',
};
function categoryLabel(r: NzbResult): string {
  if (r.categoryId != null && CATEGORY_LABELS[r.categoryId]) return CATEGORY_LABELS[r.categoryId];
  return r.category || (r.categoryId != null ? String(r.categoryId) : '--');
}

// Sort a COPY. Missing values (null grabs, size 0, empty/invalid date) always sink to the bottom.
function sortResults(rows: NzbResult[], key: SortKey | null, dir: SortDir): NzbResult[] {
  if (!key) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  const numeric = (r: NzbResult): number | null => {
    if (key === 'sizeBytes') return r.sizeBytes > 0 ? r.sizeBytes : null;
    if (key === 'grabs') return r.grabs;
    if (key === 'pubDate') {
      const t = Date.parse(r.pubDate);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  };
  const isText = key === 'title' || key === 'category';
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (isText) {
        const av = key === 'category' ? categoryLabel(a.r) : a.r.title;
        const bv = key === 'category' ? categoryLabel(b.r) : b.r.title;
        const cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp * sign : a.i - b.i;
      }
      const av = numeric(a.r);
      const bv = numeric(b.r);
      // missing always last, regardless of dir
      if (av === null && bv === null) return a.i - b.i;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av !== bv ? (av - bv) * sign : a.i - b.i;
    })
    .map((x) => x.r);
}
```

Then derive the rendered rows: `const sorted = sortResults(results, sortKey, sortDir);` and map over `sorted` instead of `results` in the table body.

- [ ] **Step 3: Rewrite the results table (headers + entire row body)**

**Replace the whole `<table className="data-table">…</table>`**, including deleting
the old `const size = r.enclosure?.['@attributes']?.length || r.size || '0';`
line and the entire old `results.map(...)` body — those reference old fields
(`r.size`, `r.enclosure`) that no longer exist on the new `NzbResult` and would
be type errors. Map over `sorted` (from Step 2), not `results`.

Replace the `<thead>` with sortable headers (a small arrow shows the active column/dir). Columns: Name, Category, Age, Size, Grabs, Action:

```tsx
<thead>
  <tr>
    {([
      ['title', 'Name'], ['category', 'Category'], ['pubDate', 'Age'],
      ['sizeBytes', 'Size'], ['grabs', 'Grabs'],
    ] as [SortKey, string][]).map(([key, label]) => (
      <th key={key} onClick={() => clickSort(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
        {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    ))}
    <th>Action</th>
  </tr>
</thead>
```

In the row body, render the cells from the new shape:

```tsx
<td className="name-cell">{r.title}</td>
<td>{categoryLabel(r)}</td>
<td>{formatAge(r.pubDate)}</td>
<td>{formatSize(String(r.sizeBytes))}</td>
<td>{r.grabs != null ? r.grabs : '--'}</td>
```

(Keep `formatSize`; it already accepts a byte string. The Action cell is rebuilt in Task 6.)

- [ ] **Step 4: Extend `formatAge` to show months (display only)**

Replace `formatAge` with:

```tsx
  const formatAge = (dateStr?: string) => {
    if (!dateStr) return '?';
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return '?';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day';
    if (days < 60) return `${days} days`;
    const months = Math.floor(days / 30);
    return months < 24 ? `${months} mths` : `${Math.floor(days / 365)} yrs`;
  };
```

- [ ] **Step 5: Do NOT build or commit yet** — continue straight into Task 6
(same file; it compiles only after Task 6's Action cell + state changes land).

---

### Task 6: Arr-routed grab + Grabbed/Rejected/Error feedback (same file)

**Files:**
- Modify: `client/src/pages/SearchPage.tsx` (continues Task 5; single build + commit here)

- [ ] **Step 1: Remove old grab code; add new grab state + helpers**

**Delete these leftovers** (they're now unused and would fail `noUnusedLocals`,
or reference removed cells): the `sending` and `sent` `useState` declarations,
the entire `sendToSab` function, and any remaining old references. (`grabToSab`
below replaces `sendToSab`.) Then add:

```tsx
  type GrabState = 'idle' | 'sending' | 'grabbed' | 'rejected' | 'error';
  const [grab, setGrab] = useState<Record<string, { state: GrabState; msg?: string }>>({});
  const setRow = (guid: string, v: { state: GrabState; msg?: string }) =>
    setGrab((p) => ({ ...p, [guid]: v }));
```

Module-scope helpers for routing + decision interpretation:

```tsx
// thousands-band routing: TV 5xxx -> sonarr, Movies 2xxx -> radarr, Audio 3xxx -> sab
type ArrTarget = 'sonarr' | 'radarr';
function bandTarget(catId: number | null | undefined): ArrTarget | 'sab' | null {
  if (catId == null) return null;
  const band = Math.floor(catId / 1000);
  if (band === 5) return 'sonarr';
  if (band === 2) return 'radarr';
  if (band === 3) return 'sab';
  return null;
}
// filter value from the dropdown is a category code string ('' = All)
function filterTarget(filterCat: string): ArrTarget | 'sab' | null {
  return bandTarget(filterCat ? parseInt(filterCat, 10) : null);
}
// Interpret a release/push response into a row outcome. Safe defaults:
// non-2xx -> error; any rejections/temporarilyRejected -> rejected; else grabbed.
function interpretPush(status: number, data: unknown): { state: GrabState; msg?: string } {
  if (status < 200 || status >= 300) {
    const m = (data as { error?: string; message?: string })?.error
      || (data as { message?: string })?.message || `HTTP ${status}`;
    return { state: 'error', msg: String(m) };
  }
  const d = (Array.isArray(data) ? data[0] : data) as {
    approved?: boolean; rejected?: boolean; temporarilyRejected?: boolean;
    rejections?: ({ reason?: string } | string)[];
  } | undefined;
  const rejections = d?.rejections;
  if ((Array.isArray(rejections) && rejections.length > 0) || d?.rejected || d?.temporarilyRejected) {
    const first = rejections?.[0];
    const reason = typeof first === 'string' ? first : first?.reason;
    return { state: 'rejected', msg: reason || 'Rejected by ' + (d?.rejected ? 'indexer' : 'the app') };
  }
  return { state: 'grabbed' };
}
```

- [ ] **Step 2: Add the grab actions**

```tsx
  const grabToArr = async (r: NzbResult, target: ArrTarget) => {
    setRow(r.guid, { state: 'sending' });
    try {
      const res = await api.post('/nzbgeek/send-to-arr', {
        title: r.title, nzbUrl: r.link, pubDate: r.pubDate, target,
      });
      setRow(r.guid, interpretPush(res.status, res.data));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number; data?: unknown } })?.response?.status;
      const data = (err as { response?: { data?: unknown } })?.response?.data;
      setRow(r.guid, interpretPush(status ?? 0, data));
    }
  };

  const grabToSab = async (r: NzbResult) => {
    setRow(r.guid, { state: 'sending' });
    try {
      await api.post('/nzbgeek/send-to-sab', { title: r.title, nzbUrl: r.link });
      setRow(r.guid, { state: 'grabbed', msg: 'Sent to SAB (no auto-import)' });
    } catch {
      setRow(r.guid, { state: 'error', msg: 'SAB error' });
    }
  };
```

- [ ] **Step 2 note (axios status):** `api` treats non-2xx as a throw, so a 4xx/5xx from `send-to-arr` (incl. the arr's own error passthrough) lands in `catch`; a 2xx decision (approved OR rejected-with-rejections) lands in the `try`. `interpretPush` handles both entry points identically.

- [ ] **Step 3: Render the Action cell**

Replace the Action `<td>` with routing-aware buttons + feedback:

```tsx
<td>
  {(() => {
    const g = grab[r.guid]?.state ?? 'idle';
    if (g === 'grabbed') return <span className="badge badge-success" title={grab[r.guid]?.msg}>Grabbed</span>;
    // rejected uses badge-warning (amber) to read as "heads up, add it to the library",
    // distinct from error's badge-danger (red). Both classes exist in index.css.
    if (g === 'rejected') return <span className="badge badge-warning" title={grab[r.guid]?.msg}>Rejected: {grab[r.guid]?.msg}</span>;
    if (g === 'sending') return <span className="placeholder">Sending…</span>;

    // Resolve target: filter first, then result category band.
    // Note: when resolved === 'sab' (Audio 3xxx), there is deliberately NO
    // Sonarr/Radarr branch below — only the "→ SAB" escape hatch renders, which
    // is the intended primary action for Audio.
    const ft = filterTarget(category);
    const rt = bandTarget(r.categoryId);
    const resolved = ft ?? rt;

    return (
      <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        {resolved === 'sonarr' && <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'sonarr')}>Sonarr</button>}
        {resolved === 'radarr' && <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'radarr')}>Radarr</button>}
        {resolved == null && (
          <>
            <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'sonarr')}>Sonarr</button>
            <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'radarr')}>Radarr</button>
          </>
        )}
        {/* SAB escape hatch — always available; won't auto-import */}
        <button className="btn-sm" title="Send straight to SABnzbd (won't auto-import into Plex)" onClick={() => grabToSab(r)}>→ SAB</button>
        {g === 'error' && <span className="badge badge-danger" title={grab[r.guid]?.msg}>Error</span>}
      </div>
    );
  })()}
</td>
```

(Badge classes `badge-success`, `badge-warning`, `badge-danger` and `btn-sm`/
`btn-primary`/`placeholder` all exist in `client/src/index.css` — confirmed — so
no substitution is needed.)

- [ ] **Step 4: Typecheck/build the client (the single gate for Tasks 5 + 6)**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` completes with **no type errors** and produces
`client/dist`. If `tsc` reports an unused local, it's almost certainly a leftover
from the old grab code (Task 6 Step 1) or the `Send` import (Task 5 Step 1) —
remove it.

- [ ] **Step 5: Commit (the whole SearchPage rewrite, Tasks 5 + 6)**

```bash
git add client/src/pages/SearchPage.tsx
git commit -m "feat(client): sortable columns + grab via Sonarr/Radarr with feedback"
```

---

## Chunk 4: Verification and rollout

### Task 7: Full local build + test

- [ ] **Step 1: Server tests + build**

Run: `cd server && npm test && npm run build`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 2: Client build**

Run: `cd client && npm run build`
Expected: no type errors.

- [ ] **Step 3: No secrets committed**

Run (note: **not** `-i`, and exclude the `REDACTED` placeholder — a
case-insensitive `[a-z0-9]{8,}` matches the word REDACTED and false-positives):
```bash
cd /c/Projects/NGConnect
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK — real key committed" || echo "no embedded keys - good"
```
Expected: "no embedded keys - good" (the fixture's only `apikey=` values are `apikey=REDACTED`).

---

### Task 8: Merge to main, then USER-RUN live grab test on the server PC

The Sonarr/Radarr integration can only be verified where the arrs are reachable (the server PC, `localhost`). Because auto-deploy is live, merging to `main` and pushing deploys the change to the server PC, where the user runs the live test.

- [ ] **Step 1: Merge to main and push**

```bash
git checkout main
git pull --ff-only origin main    # guard against a stale local main (origin may have advanced)
git merge --no-ff feature/search-enhancements -m "feat: search page — sortable columns + grab via Sonarr/Radarr"
git push origin main
```
Expected: push succeeds; the server PC auto-deploys within the hour (or the user hits "Check for Updates Now"). **After each fix in Step 4, the user must wait for that redeploy (or trigger it) before re-testing, so they're not testing stale code.**

- [ ] **Step 2: USER-RUN — grab something IN the library**

On the server PC, with ProtonVPN connected and SAB un-paused: open the Search page, search a show/movie that IS in Sonarr/Radarr, and Grab it. Confirm: the release appears in the arr's Activity/Queue → downloads via SAB under the tv/movies category → imports into `R:\Torrents\ModernTorrents\TV Shows`/`Movies` → Plex refreshes. The row shows **Grabbed**.

- [ ] **Step 3: USER-RUN — grab something NOT in the library**

(VPN still connected, SAB still un-paused.) Search something not in Sonarr/Radarr and Grab. Confirm the row shows **Rejected: \<reason\>** (e.g. "Unknown Series") rather than a silent failure.

- [ ] **Step 4: USER-RUN — if a grab shows "Error"**

Read the message (it's the arr's passthrough). Likely fixes: `protocol` value (`"usenet"`→`"Usenet"`) or field name (`protocol`→`downloadProtocol`) in `send-to-arr`. Report the message; the controller adjusts `server/src/routes/nzbgeek.ts`, pushes, and you re-test.

- [ ] **Step 5: USER-RUN — no key leak**

In the browser Network tab on the Search page, confirm no request/response exposes the NZBGeek/Sonarr/Radarr API keys (all injection is server-side).

---

## Done criteria

- [ ] `/nzbgeek/search` returns `{ results }` from `parseNewznabResults` with `extended=1`; parser tests (incl. real-fixture regression) pass in `npm test`.
- [ ] `POST /nzbgeek/send-to-arr` pushes to Sonarr/Radarr with the NZBGeek key injected server-side; validates inputs; passes the arr decision through.
- [ ] Search page shows sortable Name/Category/Age/Size/Grabs; grabs route to Sonarr/Radarr by category (two-button fallback when ambiguous), with a labeled SAB escape hatch; rows show Grabbed/Rejected/Error.
- [ ] Server `tsc` + client `vite` build clean; no API keys committed.
- [ ] Live grab test passes on the server PC (in-library → Grabbed + import + Plex; not-in-library → Rejected).
