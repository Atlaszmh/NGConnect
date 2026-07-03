# History Failure Reason Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the arr failure reason inline under the title on failed rows of the Downloads → History tab.

**Architecture:** Add a `reason: string | null` field to `HistoryItem`, extracted from `data.message` for failed events in the pure `normalizeArrHistory`; render it as a small wrapping red line under the title on failed rows, with a `.history-fail-reason` CSS rule that resets the truncating title cell's `nowrap`.

**Tech Stack:** Express 5 + TypeScript (server), React 19 + Vite (client), vitest.

**Spec:** [docs/superpowers/specs/2026-07-03-history-failure-reason-design.md](../specs/2026-07-03-history-failure-reason-design.md)

**Branch:** `feature/history-failure-reason` (already checked out). NOT merged to `main` until the end.

---

## File Structure

**New:**
- `server/src/services/__fixtures__/sonarr-history-failed.json` — the real captured Sonarr `downloadFailed` record (nothing secret; committed as-is).

**Modified:**
- `server/src/services/arrHistory.ts` — add `reason` to `HistoryItem` + extract from `data.message` for failed events.
- `server/src/services/arrHistory.test.ts` — real-fixture + reason unit cases.
- `client/src/pages/DownloadsPage.tsx` — `reason` on the client `HistoryItem`; inline reason on failed rows.
- `client/src/index.css` — `.history-fail-reason` rule.

---

## Chunk 1: Failure reason end-to-end

### Task 1: Real fixture + normalizer `reason` (TDD)

**Files:**
- Create: `server/src/services/__fixtures__/sonarr-history-failed.json`
- Modify: `server/src/services/arrHistory.ts`
- Modify: `server/src/services/arrHistory.test.ts`

- [ ] **Step 1: Add the real fixture**

Create `server/src/services/__fixtures__/sonarr-history-failed.json` (verbatim from the real capture; nothing secret):

```json
{
  "records": [
    {
      "episodeId": 1246,
      "seriesId": 17,
      "sourceTitle": "Widows.Bay.S01.1080p.WEBRip.10bit.DDP5.1.x265-NeoNoir",
      "quality": { "quality": { "id": 15, "name": "WEBRip-1080p" } },
      "date": "2026-07-03T18:53:25Z",
      "downloadId": "SABnzbd_nzo_w9qb43ys",
      "eventType": "downloadFailed",
      "data": {
        "downloadClient": "SABnzbd",
        "message": "Aborted, cannot be completed - https://sabnzbd.org/not-complete",
        "releaseGroup": "NeoNoir",
        "size": "0"
      },
      "id": 223
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

At the top of `server/src/services/arrHistory.test.ts`, ensure these imports exist (add `fs`/`path` if missing):

```ts
import fs from 'fs';
import path from 'path';
```

Append this describe block:

```ts
describe('normalizeArrHistory — failure reason', () => {
  it('extracts reason + size from the REAL captured Sonarr failed record', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/sonarr-history-failed.json'), 'utf-8')
    );
    const [item] = normalizeArrHistory(null, raw); // the record is a Sonarr record
    expect(item).toMatchObject({
      source: 'sonarr',
      kind: 'tv',
      event: 'failed',
      reason: 'Aborted, cannot be completed - https://sabnzbd.org/not-complete',
      sizeBytes: 0, // data.size "0"
      // raw capture has no series/episode include object → title falls back to sourceTitle
      title: 'Widows.Bay.S01.1080p.WEBRip.10bit.DDP5.1.x265-NeoNoir',
    });
  });

  it('reason is null for imported rows', () => {
    // radarrImported() / sonarrImported() are the existing helpers in this file
    const items = normalizeArrHistory(wrap([radarrImported()]), wrap([sonarrImported()]));
    expect(items.every((i) => i.reason === null)).toBe(true);
  });

  it('reason is null for a failed record with no data.message', () => {
    const rec = { id: 3, eventType: 'downloadFailed', sourceTitle: 'X-GRP', date: '2026-07-01T00:00:00Z', data: { size: '123' } };
    const [item] = normalizeArrHistory(wrap([rec]), null);
    expect(item.event).toBe('failed');
    expect(item.reason).toBeNull();
  });

  it('extracts reason from a synthetic failed record with data.message', () => {
    const rec = { id: 4, eventType: 'downloadFailed', sourceTitle: 'Y-GRP', date: '2026-07-01T00:00:00Z', data: { message: 'boom', size: '9' } };
    const [item] = normalizeArrHistory(wrap([rec]), null);
    expect(item.reason).toBe('boom');
  });
});
```

(This reuses the `wrap`, `radarrImported`, `sonarrImported` helpers already defined at the top of the existing test file.)

- [ ] **Step 3: Run to verify fail**

Run: `cd server && npx vitest run src/services/arrHistory.test.ts`
Expected: FAIL — `reason` is `undefined`/missing on the results.

- [ ] **Step 4: Implement in `arrHistory.ts`**

Add `reason` to the `HistoryItem` interface (after `date`):

```ts
  reason: string | null;      // failure reason (data.message) for failed events; null otherwise
```

In `normalizeRecord`, after `const event = EVENT_MAP[eventType];` and the `if (!event) return null;` guard, and after `const data = ...` is computed, add:

```ts
  const reason =
    event === 'failed' && typeof data.message === 'string' && data.message
      ? data.message
      : null;
```

Add `reason` to the returned object:

```ts
  return { id, source, kind, title, event, quality, sizeBytes, date, reason };
```

(`data` is already defensively derived as `rec.data && typeof rec.data === 'object' ? (rec.data as Dict) : {}`, so `data.message` access is safe.)

- [ ] **Step 5: Run to verify pass**

Run: `cd server && npx vitest run src/services/arrHistory.test.ts`
Expected: PASS (existing 7 + the 4 new).

- [ ] **Step 6: Full suite + build**

Run: `cd server && npm test && npm run build`
Expected: all tests pass; `tsc` exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/arrHistory.ts server/src/services/arrHistory.test.ts server/src/services/__fixtures__/sonarr-history-failed.json
git commit -m "feat(server): history reason from data.message (failed events) + real fixture"
```

---

### Task 2: Client — inline reason on failed rows

**Files:**
- Modify: `client/src/pages/DownloadsPage.tsx`
- Modify: `client/src/index.css`

No client test framework — the build is the gate; live render is Task 3.

- [ ] **Step 1: Add `reason` to the client `HistoryItem`**

In `DownloadsPage.tsx`, add to the `HistoryItem` interface (mirror the server):

```tsx
  reason: string | null;
```

- [ ] **Step 2: Render the reason under the title on failed rows**

In the History table body, change the Title cell from:

```tsx
<td className="name-cell">{item.title}</td>
```

to:

```tsx
<td className="name-cell">
  {item.title}
  {item.reason && <div className="history-fail-reason">{item.reason}</div>}
</td>
```

(`reason` is `null` for imported rows server-side, so `item.reason &&` alone is the right guard.)

- [ ] **Step 3: Add the CSS rule**

Append to `client/src/index.css` (a `.history-fail-reason` rule that resets the `.name-cell` inherited `white-space: nowrap` so the reason wraps, and uses the existing danger color):

```css
.history-fail-reason {
  white-space: normal;
  color: var(--color-danger);
  font-size: 0.8em;
  margin-top: 3px;
}
```

- [ ] **Step 4: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors; `client/dist` produced.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/DownloadsPage.tsx client/src/index.css
git commit -m "feat(client): show failure reason under title on failed history rows"
```

---

## Chunk 2: Verification and rollout

### Task 3: Verify, merge, USER-RUN live check

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /c/Projects/NGConnect
(cd server && npm test && npm run build) && (cd client && npm run build)
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK" || echo "no embedded keys - good"
```
Expected: server tests pass, both builds exit 0, "no embedded keys - good". (The fixture has no key.)

- [ ] **Step 2: Merge and push**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff feature/history-failure-reason -m "feat: show failure reason on Downloads History failed rows"
git push origin main
```
Expected: push succeeds; server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — reason shows on failed rows**

On the server PC: Downloads → History → confirm failed rows now show the reason inline under the title (e.g. the `Widows.Bay` "Aborted, cannot be completed…" message), that the reason wraps (not clipped), and imported rows are unchanged. Bonus: confirm imported rows show a real **Size** (the `data.size` field is now confirmed).

---

## Done criteria

- [ ] `normalizeArrHistory` sets `reason` from `data.message` for failed events (null otherwise); real-fixture + synthetic tests pass.
- [ ] Failed History rows render the reason inline under the title (wrapping, red), imported rows unchanged.
- [ ] Server `tsc` + client `vite` build clean; no committed keys.
- [ ] Live check: failed rows show the wrapped reason on the server PC.
