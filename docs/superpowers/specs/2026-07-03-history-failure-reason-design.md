# History Failure Reason — Design Spec

**Date:** 2026-07-03
**Status:** Approved (pending spec review)
**Author:** Zach + Claude

## Problem

The Downloads → History tab (shipped 2026-07-03) shows failed downloads as a bare
red **"Failed"** badge with no explanation. The user can't tell *why* something
failed without leaving NGConnect for the Sonarr/Radarr UI. The arr history record
already carries the reason; we just don't surface it.

## Goals

- For **failed** history rows, show the arr's failure **reason** inline (a small
  muted line under the release title).
- Imported rows are unchanged.
- Ground the reason (and confirm the size) against a **real captured arr record**
  so these `data` fields are verified, not guessed.

## Non-Goals

- Any other per-row enrichment (indexer, download client, release group). The
  arr record carries these (`data.downloadClient`, `data.releaseGroup`), but they
  are out of scope — this is only about the failure reason.
- Changing imported rows, the Queue tab, columns, or paging.

## Real Findings (verified from a real Sonarr `downloadFailed` record)

A real captured record (the `Widows.Bay.S01…-NeoNoir` failure) confirms:
- **Reason lives at `data.message`** — e.g. `"Aborted, cannot be completed -
  https://sabnzbd.org/not-complete"`.
- **Size lives at `data.size`** (the field the prior feature already reads) — a
  string; here `"0"` because the download aborted (so this row shows Size `--`;
  imported rows carry the real byte count there).
- `data` also has `downloadClient`/`releaseGroup` (out of scope).
- The record contains nothing secret (release name, a SAB `nzo` id, a public URL,
  no API key), so it can be committed verbatim as a test fixture.

## Design

A single field threaded through the existing pipeline.

**Server — `server/src/services/arrHistory.ts`:**
- Add `reason: string | null` to `HistoryItem`.
- In `normalizeRecord`, set `reason` from `data.message` **only for failed
  events** (imported → `null`): `event === 'failed' && typeof data.message ===
  'string' && data.message ? data.message : null`. Everything else in the
  normalizer is unchanged.

**Client — `client/src/pages/DownloadsPage.tsx`:**
- Add `reason: string | null` to the client `HistoryItem` (mirror server).
- In the failed-row rendering, when `item.reason` is present, render it as a
  small muted/red line beneath the title in the Title cell, e.g.:
  ```tsx
  <td className="name-cell">
    {item.title}
    {item.event === 'failed' && item.reason && (
      <div className="history-fail-reason">{item.reason}</div>
    )}
  </td>
  ```
  Use an existing muted/danger text style if one fits; otherwise a minimal inline
  style (small, muted-red) is acceptable — no need for a new CSS system.

## Data Flow

Unchanged from the history feature, plus one field: arr `/history` record →
`normalizeArrHistory` (now also extracts `data.message`→`reason` for failed) →
`{ items }` → History tab renders the reason under the title on failed rows.

## Error Handling

| Case | Behavior |
|---|---|
| Failed record with no `data.message` | `reason: null`; row shows "Failed" with no reason line (no empty element). |
| Imported record | `reason: null` always. |
| `data.message` not a string / `data` missing | `reason: null` (guarded). |

## Testing Strategy

- **Normalizer (real logic):** extend `arrHistory.test.ts`:
  - **Real fixture:** the captured `Widows.Bay` `downloadFailed` record →
    `event:'failed'`, `reason:'Aborted, cannot be completed - https://sabnzbd.org/not-complete'`,
    `sizeBytes: 0` (from `"0"`), `title` falling back to `sourceTitle` (this raw
    sample has no `series`/`episode` include object). Commit the record as
    `server/src/services/__fixtures__/sonarr-history-failed.json` (no redaction
    needed — nothing secret).
  - **Synthetic:** an imported record → `reason: null`; a failed record with no
    `data.message` → `reason: null`.
- **Client:** `npm run build` (typecheck) + the user-run check.
- **USER-RUN on the server PC:** Downloads → History → confirm failed rows now
  show the reason inline (e.g. the `Widows.Bay` "Aborted…" message), imported rows
  unchanged, and — bonus — that imported rows show a real Size now that `data.size`
  is confirmed.

## Files Touched

**New:**
- `server/src/services/__fixtures__/sonarr-history-failed.json` — the real
  captured failed record (committed as-is).
- `docs/superpowers/specs/2026-07-03-history-failure-reason-design.md` (this file).

**Modified:**
- `server/src/services/arrHistory.ts` — `reason` field + extraction.
- `server/src/services/arrHistory.test.ts` — fixture + reason cases.
- `client/src/pages/DownloadsPage.tsx` — `reason` in the type; inline reason on
  failed rows.
