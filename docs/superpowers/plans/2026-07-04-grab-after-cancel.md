# Grab-After-Cancel Fix (arr-aware cancel) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "cancel download" remove the item from SABnzbd AND clear the arr's grab (remove + blocklist via the arr queue) so a different release for the same movie/episode can be grabbed immediately after.

**Architecture:** A new server service `cancelDownload.ts` with a pure, unit-tested `findQueueMatch` (which arr + queue-item id owns a SAB `nzo_id`) plus thin arr/SAB I/O; exposed as `POST /system/cancel-download { nzoId }`. The Downloads page's cancel calls this instead of the direct SAB delete. All arr/SAB keys stay server-side.

**Tech Stack:** Express 5 + TypeScript (server, strict, vitest), React 19 + Vite + axios (client, strict). `server/tsconfig.json` excludes `**/*.test.ts` (don't remove that).

**Spec:** [docs/superpowers/specs/2026-07-04-grab-after-cancel-design.md](../specs/2026-07-04-grab-after-cancel-design.md)

**Branch:** `feature/grab-after-cancel` (already checked out). NOT merged to `main` until the end.

**⚠️ Live-verify hypothesis:** the fix assumes the arr `DELETE queue?removeFromClient&blocklist&skipRedownload` clears the "recent grab meets cutoff" block. This is the standard Sonarr/Radarr flow but is **unconfirmed until the server-PC live check** (arrs are localhost-only). The contingency (also remove the arr history grab record) is documented in the spec; do NOT bake it in unless the live check shows the block persists.

---

## File Structure

**New:**
- `server/src/services/cancelDownload.ts` — `findQueueMatch` (pure) + `arrQueueRecords`/`arrDeleteQueueItem`/`sabDelete` (thin I/O) + `cancelDownload` orchestrator.
- `server/src/services/cancelDownload.test.ts` — `findQueueMatch` unit tests.

**Modified:**
- `server/src/routes/system.ts` — `POST /system/cancel-download`.
- `client/src/pages/DownloadsPage.tsx` — `deleteItem` calls the new endpoint.

---

## Chunk 1: Server — arr-aware cancel

### Task 1: `findQueueMatch` (pure, TDD)

**Files:**
- Create: `server/src/services/cancelDownload.ts`
- Create: `server/src/services/cancelDownload.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/cancelDownload.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findQueueMatch } from './cancelDownload';

const rec = (id: number, downloadId?: string) => ({ id, downloadId });

describe('findQueueMatch', () => {
  it('finds a Sonarr match by downloadId', () => {
    expect(findQueueMatch([rec(5, 'abc'), rec(6, 'xyz')], [], 'xyz')).toEqual({ arr: 'sonarr', id: 6 });
  });
  it('finds a Radarr match by downloadId', () => {
    expect(findQueueMatch([], [rec(9, 'mov1')], 'mov1')).toEqual({ arr: 'radarr', id: 9 });
  });
  it('returns null when neither queue has it', () => {
    expect(findQueueMatch([rec(1, 'a')], [rec(2, 'b')], 'zzz')).toBeNull();
  });
  it('returns null for empty queues', () => {
    expect(findQueueMatch([], [], 'anything')).toBeNull();
  });
  it('skips records with no downloadId', () => {
    expect(findQueueMatch([rec(1)], [], 'anything')).toBeNull();
  });
  it('prefers Sonarr when both (pathologically) contain the id', () => {
    expect(findQueueMatch([rec(1, 'dup')], [rec(2, 'dup')], 'dup')).toEqual({ arr: 'sonarr', id: 1 });
  });
  it('matches exactly — no trim or case-fold', () => {
    expect(findQueueMatch([rec(1, 'ABC')], [], 'abc')).toBeNull();
    expect(findQueueMatch([rec(1, ' abc ')], [], 'abc')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/services/cancelDownload.test.ts`
Expected: FAIL — `findQueueMatch` not exported / file missing.

- [ ] **Step 3: Implement `findQueueMatch`**

Create `server/src/services/cancelDownload.ts`:

```ts
export interface ArrQueueRecord {
  id: number;
  downloadId?: string;
}

export type ArrTarget = 'sonarr' | 'radarr';

// Which arr + queue-item id owns this SAB nzo_id. Sonarr is checked before Radarr
// (a given nzo_id belongs to at most one). Exact-string match on downloadId.
export function findQueueMatch(
  sonarr: ArrQueueRecord[],
  radarr: ArrQueueRecord[],
  nzoId: string,
): { arr: ArrTarget; id: number } | null {
  const inSonarr = sonarr.find((r) => r.downloadId === nzoId);
  if (inSonarr) return { arr: 'sonarr', id: inSonarr.id };
  const inRadarr = radarr.find((r) => r.downloadId === nzoId);
  if (inRadarr) return { arr: 'radarr', id: inRadarr.id };
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/services/cancelDownload.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/cancelDownload.ts server/src/services/cancelDownload.test.ts
git commit -m "feat(server): findQueueMatch — map a SAB nzo_id to its arr queue item"
```

---

### Task 2: arr/SAB I/O + `cancelDownload` orchestrator

**Files:**
- Modify: `server/src/services/cancelDownload.ts`

No new unit tests (thin I/O; behavior is the live check). The build typechecks it.

- [ ] **Step 1: Add imports at the TOP of `cancelDownload.ts`**

Above the existing `export interface ArrQueueRecord`:

```ts
import { config } from '../config';
import { createServiceLogger } from './logger';
import type { ArrBase } from './arrAdd';

const log = createServiceLogger('cancel-download');
```

(`ArrBase` is `{ url: string; apiKey: string }`, exported from `arrAdd.ts`; `config.sonarr`/`config.radarr`/`config.sabnzbd` are structurally compatible.)

- [ ] **Step 2: Append the I/O helpers + orchestrator**

Append to `cancelDownload.ts`:

```ts
async function arrQueueRecords(base: ArrBase): Promise<ArrQueueRecord[]> {
  try {
    const res = await fetch(`${base.url}/api/v3/queue?page=1&pageSize=200`, {
      headers: { 'X-Api-Key': base.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { records?: ArrQueueRecord[] };
    return data.records ?? [];
  } catch {
    return []; // down or hung arr must not block cancel
  }
}

async function arrDeleteQueueItem(base: ArrBase, id: number): Promise<void> {
  const url = `${base.url}/api/v3/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=true`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-Api-Key': base.apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`arr queue delete failed: HTTP ${res.status}`);
}

async function sabDelete(nzoId: string): Promise<void> {
  const url = new URL(`${config.sabnzbd.url}/api`);
  url.searchParams.set('apikey', config.sabnzbd.apiKey);
  url.searchParams.set('mode', 'queue');
  url.searchParams.set('name', 'delete');
  url.searchParams.set('value', nzoId);
  url.searchParams.set('output', 'json');
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SAB delete failed: HTTP ${res.status}`);
}

// Cancel a download: if the nzo_id is in an arr queue, delete it there with
// removeFromClient+blocklist+skipRedownload (removes from SAB AND marks the grab
// failed so a different release can be grabbed); otherwise fall back to a plain
// SAB delete. An arr-delete failure also falls back to SAB so cancel is never a
// silent no-op.
export async function cancelDownload(
  nzoId: string,
): Promise<{ via: ArrTarget | 'sab'; blocklisted: boolean }> {
  const [sonarrQueue, radarrQueue] = await Promise.all([
    arrQueueRecords(config.sonarr),
    arrQueueRecords(config.radarr),
  ]);
  const match = findQueueMatch(sonarrQueue, radarrQueue, nzoId);
  if (match) {
    const base = match.arr === 'sonarr' ? config.sonarr : config.radarr;
    try {
      await arrDeleteQueueItem(base, match.id);
      return { via: match.arr, blocklisted: true };
    } catch (err) {
      log.warn('arr queue delete failed; falling back to SAB delete', {
        arr: match.arr,
        id: match.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await sabDelete(nzoId); // no arr match, or arr delete failed
  return { via: 'sab', blocklisted: false };
}
```

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: `tsc` exit 0 (strict). `findQueueMatch` is used by `cancelDownload`; no unused symbols.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/cancelDownload.ts
git commit -m "feat(server): cancelDownload — arr queue remove+blocklist with SAB fallback"
```

---

### Task 3: Route — `POST /system/cancel-download`

**Files:**
- Modify: `server/src/routes/system.ts`

- [ ] **Step 1: Add the import**

In `server/src/routes/system.ts`, after the other service imports (near the `queueSort` import added earlier):

```ts
import { cancelDownload } from '../services/cancelDownload';
```

- [ ] **Step 2: Add the endpoint** (place it near the other POST endpoints, e.g. after `/update/check`)

```ts
// Cancel a download: remove from SABnzbd, and if it's tracked by Sonarr/Radarr,
// remove+blocklist there so a different release can be grabbed (see spec).
systemRouter.post('/cancel-download', async (req: Request, res: Response) => {
  const { nzoId } = req.body ?? {};
  if (typeof nzoId !== 'string' || !nzoId) {
    res.status(400).json({ error: 'nzoId (non-empty string) is required' });
    return;
  }
  try {
    const result = await cancelDownload(nzoId);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cancel failed';
    console.error('cancel-download error:', message);
    res.status(502).json({ error: message });
  }
});
```

- [ ] **Step 3: Full server suite + build**

Run: `cd server && npm test && npm run build`
Expected: all suites pass (existing + the new `findQueueMatch` tests); `tsc` exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): POST /system/cancel-download endpoint"
```

---

## Chunk 2: Client — cancel calls the arr-aware endpoint

### Task 4: `DownloadsPage.deleteItem`

**Files:**
- Modify: `client/src/pages/DownloadsPage.tsx`

- [ ] **Step 1: Swap the SAB delete for the new endpoint**

Replace `deleteItem` (currently `DownloadsPage.tsx:215-220`):

```tsx
  const deleteItem = async (nzoId: string) => {
    await api.get('/sabnzbd/api', {
      params: { mode: 'queue', name: 'delete', value: nzoId },
    });
    fetchQueue();
  };
```

with:

```tsx
  const deleteItem = async (nzoId: string) => {
    await api.post('/system/cancel-download', { nzoId });
    fetchQueue();
  };
```

(The button/UX is otherwise unchanged; `api` is the existing axios instance, base `/api`. No new imports.)

- [ ] **Step 2: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors; `client/dist` produced.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/DownloadsPage.tsx
git commit -m "feat(client): cancel download via arr-aware /system/cancel-download"
```

---

## Chunk 3: Verification and rollout

### Task 5: Verify, merge, USER-RUN live check

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /c/Projects/NGConnect
(cd server && npm test && npm run build) && (cd client && npm run build)
git grep -nE "apikey=[A-Za-z0-9]{8,}" -- server/ client/ | grep -v "apikey=REDACTED" && echo "LEAK" || echo "no embedded keys - good"
```
Expected: server tests pass (incl. `findQueueMatch`), both builds exit 0, "no embedded keys - good".

- [ ] **Step 2: Confirm no divergence, then merge and push**

```bash
git fetch origin
git log --oneline HEAD..origin/main   # expect EMPTY
git checkout main
git merge --ff-only origin/main
git merge --no-ff feature/grab-after-cancel -m "fix: arr-aware cancel so re-grab after cancel isn't blocked by 'recent grab meets cutoff'"
(cd server && npm test) && git push origin main
```
Expected: `HEAD..origin/main` empty; merged tests pass; push succeeds. Server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — live check on the server PC** (arrs are localhost-only)

1. Grab a release for a movie/episode so a download is in SAB **and** the arr's queue.
2. **Cancel** it from the Downloads page.
3. Confirm: gone from **SAB**; gone from the **arr's Activity/Queue**; the arr shows the release **blocklisted / grab failed**; and the arr did **not** auto-grab a replacement.
4. **The decisive assertion:** on the Search page, grab a **different** release for the **same** movie/episode → it is now **accepted** (no "Recent grab meets cutoff" rejection). ✅ = the fix works. ❌ still rejected → the blocklist alone didn't clear the block; apply the spec's **contingency** (remove the arr history grab record) as a follow-up.
5. Cancel a **SAB-only** download (nothing in the arr queue) → still removed from SAB (fallback path).

---

## Done criteria

- [ ] `findQueueMatch` implemented + unit-tested (Sonarr/Radarr/neither/empty/no-downloadId/precedence/exact-match); full server suite + `tsc` green.
- [ ] `cancelDownload` removes+blocklists via the matched arr, falls back to SAB (no arr match OR arr-delete failure); 10s timeouts; keys server-side.
- [ ] `POST /system/cancel-download` validates `nzoId`, returns `{ via, blocklisted }`, 400/502 on bad input/failure.
- [ ] Client cancel calls the new endpoint; builds clean.
- [ ] No committed keys; merged to main and pushed.
- [ ] Live check: after cancel, a different release for the same item can be grabbed (or the contingency is scheduled if not).
