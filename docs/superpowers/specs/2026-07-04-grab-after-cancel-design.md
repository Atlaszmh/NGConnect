# Grab-After-Cancel Fix (arr-aware cancel) — Design Spec

**Date:** 2026-07-04
**Status:** Proposed (planned unattended — decisions + a live-verify hypothesis flagged for Zach's review)
**Author:** Claude (for Zach)

> **Note:** Zach asked me to design + plan this while away. The root cause is
> solid, but the *fix* depends on one arr behavior I can't confirm without the
> live instance (localhost-only). That hypothesis is called out explicitly under
> "Key uncertainty" and is the first thing the live check verifies. **Decision**
> lines mark choices you may change on review.

## Problem

Cancelling a download early and then trying to grab a *different* release for the
same movie/episode is rejected by Sonarr/Radarr:

> *Rejected: Recent grab event in history already meets cutoff: BR-DISK v1*

**Root cause (confirmed by reading the code):** the Downloads page "cancel"
(`client/src/pages/DownloadsPage.tsx` → `deleteItem`) deletes the item **only from
SABnzbd** (`GET /sabnzbd/api?mode=queue&name=delete&value=<nzoId>`). It never tells
Sonarr/Radarr. So the arr keeps its **"grabbed" history event** for that release,
and its decision engine (the grab-history / cutoff specification) sees a recent
grab that "already meets cutoff" and rejects any new grab for the same
movie/episode. The download is gone from SAB, but the arr still thinks it has a
good grab in flight.

## Goals

- Cancelling a download **removes it from SABnzbd AND clears the arr's grab** so a
  different release for the same item can be grabbed immediately afterward.
- Cancel keeps working for downloads with **no matching arr item** (SAB-only, or
  already imported) — it must never become a no-op.
- **All arr/SAB API keys stay server-side** (the standing constraint) — the client
  sends only an `nzoId`.

## Non-Goals

- Redesigning the download flow, the queue view, or the Search/grab UI.
- Auto-selecting a replacement release on cancel (we deliberately do NOT
  auto-redownload — the user cancels to pick a different one themselves).
- Handling non-arr download clients (only SABnzbd is used here).
- A general "history editor" — this only touches the cancel action.

## Key uncertainty (verify live — do NOT assume)

The fix routes the cancel through the **arr queue delete with blocklist**, which
is the idiomatic Sonarr/Radarr "remove a bad download and let me grab an
alternative" flow. The **hypothesis** is that
`DELETE /api/v3/queue/{id}?removeFromClient=true&blocklist=true&skipRedownload=true`
records the grab as *failed* and thereby **clears the "recent grab meets cutoff"
block**, so a subsequent grab of a different release is accepted. This is very
likely correct (it's the standard flow), but per "gather real data, don't
speculate," it MUST be confirmed on the live instance (arrs are localhost-only —
see the media stack notes). **Contingency if blocklist alone doesn't clear it:**
also remove the offending Sonarr/Radarr *history* grab record (mark failed via the
history API) — more invasive, so only if the live check shows the block persists.

## Decisions (made unattended — change any on review)

- **Decision 1 — server-side, arr-aware cancel endpoint.** A new
  `POST /api/system/cancel-download { nzoId }` does the whole thing server-side
  (query both arr queues, match, delete via the arr, else fall back to SAB). This
  keeps the arr keys off the browser (constraint) and centralizes the logic. The
  client's cancel button calls this instead of the direct SAB delete.
- **Decision 2 — `removeFromClient=true & blocklist=true & skipRedownload=true`.**
  `removeFromClient` deletes it from SAB too (one call does both); `blocklist`
  marks the release failed (the part that should clear the cutoff block and stops
  that exact release being re-grabbed); `skipRedownload` stops the arr from
  auto-searching a replacement (the user will grab manually). If you'd rather cancel
  NOT blocklist, note the cutoff block likely won't clear — blocklist is the
  mechanism of the fix.
- **Decision 3 — SAB fallback when there's no arr match.** If the `nzoId` isn't in
  either arr queue (SAB-only download, or the arr already moved it out), fall back
  to the existing SAB `mode=queue&name=delete` so cancel always does something.

## Context (current state)

- **Client cancel** (`DownloadsPage.tsx:190-195`): `deleteItem(nzoId)` →
  `api.get('/sabnzbd/api', { params: { mode:'queue', name:'delete', value:nzoId } })`
  then `fetchQueue()`. The queue rows come straight from SAB (`nzo_id`).
- **Arrs are reachable server-side.** `config.sonarr` / `config.radarr` hold
  `{ url, apiKey }`; existing services (`arrAdd.ts`, `arrHistory.ts`) call the arr
  APIs with a `fetch` + `X-Api-Key` header. Sonarr/Radarr v3 expose
  `GET /api/v3/queue` (returns `{ records: [{ id, downloadId, … }] }`, where
  `downloadId` is the SAB `nzo_id`) and `DELETE /api/v3/queue/{id}` with the
  `removeFromClient`/`blocklist`/`skipRedownload` query params.
- **SAB** is proxied by `sabnzbd.ts` (`GET /sabnzbd/api` forwards params with the
  key server-side); the server can also call SAB directly like `vpnMonitor.ts`
  does (`new URL(sabnzbd.url + '/api')`, set `apikey`/`mode`/`output=json`).
- Server tests are vitest (pure-function style); arrs are localhost-only so the
  live behavior is a server-PC / user-run step.

## Architecture Overview

A new server service with a **pure, unit-tested matcher** plus thin arr/SAB I/O,
exposed as one endpoint; the client swaps its cancel call. The pure part is the
queue-matching (which arr, which queue-item id owns this `nzoId`); the I/O
(fetching the two queues, issuing the delete) wraps it.

## Component 1: `server/src/services/cancelDownload.ts` (new)

**Pure (unit-tested):**

```ts
export interface ArrQueueRecord { id: number; downloadId?: string }
export type ArrTarget = 'sonarr' | 'radarr';

// Find which arr + queue-item id owns this SAB nzo_id. Sonarr records are checked
// before Radarr (a given nzo_id belongs to at most one). Case-sensitive match on
// downloadId; returns null when neither arr has it.
export function findQueueMatch(
  sonarr: ArrQueueRecord[],
  radarr: ArrQueueRecord[],
  nzoId: string,
): { arr: ArrTarget; id: number } | null
```

**Thin I/O (not unit-tested — live):**
- `arrQueueRecords(base): Promise<ArrQueueRecord[]>` — `GET {base.url}/api/v3/queue?page=1&pageSize=200`
  with `X-Api-Key`; return `data.records ?? []`. (pageSize 200 comfortably covers
  an active queue; on error return `[]` so one arr being down doesn't block cancel.)
- `arrDeleteQueueItem(base, id)` — `DELETE {base.url}/api/v3/queue/{id}?removeFromClient=true&blocklist=true&skipRedownload=true`
  with `X-Api-Key`.
- `sabDelete(nzoId)` — the existing SAB delete (`mode=queue&name=delete&value=<nzoId>&output=json`), key server-side.
- `cancelDownload(nzoId): Promise<{ via: ArrTarget | 'sab'; blocklisted: boolean }>`:
  1. Fetch both arr queues in parallel; `findQueueMatch`.
  2. If matched → `arrDeleteQueueItem` (removes from SAB + blocklists) → `{ via: arr, blocklisted: true }`.
  3. Else → `sabDelete` → `{ via: 'sab', blocklisted: false }`.
  4. If the arr delete throws, fall back to `sabDelete` so cancel isn't a no-op
     (log the arr error); return `{ via:'sab', blocklisted:false }`.

## Component 2: route — `server/src/routes/system.ts`

```
POST /system/cancel-download   body { nzoId: string }
```
- Validate `nzoId` is a non-empty string (else 400).
- `const result = await cancelDownload(nzoId); res.json(result);`
- On unexpected throw → 502 with a message (mirrors the other system endpoints).

## Component 3: client — `DownloadsPage.tsx`

- `deleteItem(nzoId)` calls `await api.post('/system/cancel-download', { nzoId })`
  instead of the direct SAB `api.get`, then `fetchQueue()` as today.
- Optional (nice, not required): briefly surface the outcome (e.g. a toast/log
  "Cancelled + blocklisted" vs "Removed from SAB"). Keep the button/flow otherwise
  identical. v1 can simply keep the current fire-and-refetch UX.

## Data Flow

Cancel (client) → `POST /system/cancel-download {nzoId}` → server fetches
Sonarr+Radarr queues → `findQueueMatch` → arr `DELETE …removeFromClient&blocklist&skipRedownload`
(removes from SAB + marks the grab failed) → arr's cutoff block clears → user
grabs a different release on the Search page → accepted. (No arr match → SAB
delete, as before.)

## Error Handling

| Case | Behavior |
|---|---|
| `nzoId` missing/empty | route returns 400. |
| One arr unreachable when fetching queues | that queue is `[]`; match proceeds on the other; cancel still works. |
| `nzoId` not in either arr queue | SAB fallback delete (`via:'sab'`). |
| Arr delete call fails | log; fall back to SAB delete; `via:'sab'`. |
| SAB delete also fails | 502 to the client (cancel genuinely failed — surfaced). |

## Testing Strategy

- **`findQueueMatch` (pure, vitest):** nzoId in Sonarr only → `{arr:'sonarr',id}`;
  in Radarr only → `{arr:'radarr',id}`; in neither → `null`; empty arrays → `null`;
  a record with no `downloadId` is skipped; Sonarr-precedence if (pathologically)
  both contain it; exact-string match (no trim/case-fold surprises).
- **Server build:** `cd server && npm test && npm run build`.
- **Client build:** `cd client && npm run build`.
- **USER-RUN on the server PC (the decisive check — arrs localhost-only):**
  1. Grab a release for a movie/episode (so a download is in SAB + the arr queue).
  2. **Cancel** it from the Downloads page.
  3. Confirm: the item is gone from SAB **and** from the arr's Activity/Queue; the
     arr shows the release **blocklisted / grab failed**; and the arr did **not**
     auto-grab a replacement (skipRedownload).
  4. **The key assertion:** grab a **different** release for the same
     movie/episode on the Search page → it is now **accepted** (no "Recent grab
     meets cutoff" rejection). If it's still rejected, the blocklist alone didn't
     clear the block → apply the Contingency (remove the arr history grab record).
  5. Cancel a SAB-only download (no arr match) → still removed from SAB.

## Risks / Open Questions

- **The cutoff-clear hypothesis** (see "Key uncertainty") is the one real unknown;
  the live check step 4 is designed to prove or disprove it, with a documented
  contingency.
- **DELETE query-param support** (`removeFromClient`/`blocklist`/`skipRedownload`)
  is standard in Sonarr v3 / Radarr v3, but the exact param spelling/casing is
  confirmed by the live check (a 200 with the item gone from both SAB and the arr).
- **`downloadId` === SAB `nzo_id`** is the documented mapping; the pure matcher
  assumes exact-string equality. If the live queue shows a differently-cased or
  suffixed id, adjust the match (flagged for the live check).
- **Blocklist side effect:** the exact cancelled release is blocklisted (won't be
  auto-grabbed again). That's intended (you cancelled it), but worth knowing.

## Files Touched

**New:**
- `server/src/services/cancelDownload.ts` — `findQueueMatch` (pure) + arr/SAB I/O + `cancelDownload`.
- `server/src/services/cancelDownload.test.ts` — `findQueueMatch` unit tests.
- `docs/superpowers/specs/2026-07-04-grab-after-cancel-design.md` (this).

**Modified:**
- `server/src/routes/system.ts` — `POST /system/cancel-download`.
- `client/src/pages/DownloadsPage.tsx` — `deleteItem` calls the new endpoint.
