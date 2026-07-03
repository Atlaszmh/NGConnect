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
  small muted/red line beneath the title in the Title cell:
  ```tsx
  <td className="name-cell">
    {item.title}
    {item.reason && <div className="history-fail-reason">{item.reason}</div>}
  </td>
  ```
  (`reason` is `null` for imported rows server-side, so guarding on `item.reason`
  alone is sufficient.)

**Client CSS — `client/src/index.css` (REQUIRED, not optional):**
- `.name-cell` is built for single-line truncation (`white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 400px`). A child `<div>`
  **inherits `white-space: nowrap`**, so without an override the reason renders
  as one clipped/ellipsized line instead of wrapping under the title. Add a rule
  that resets wrapping and uses the existing danger color:
  ```css
  .history-fail-reason {
    white-space: normal;
    color: var(--color-danger);
    font-size: 0.8em;
    margin-top: 3px;
  }
  ```
  This lets the reason wrap within the cell (the `<td>` grows in height to fit).

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
    needed — nothing secret). **Note:** the production route DOES pass
    `includeSeries=true&includeEpisode=true`, so real production records carry a
    `series`/`episode` object and get proper `Series SxxExx` titles — the fixture
    intentionally exercises reason/size extraction, not title assembly (which the
    existing synthetic Sonarr test already covers). Don't "fix" the fixture's
    sourceTitle-fallback expectation.
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
- `client/src/index.css` — add the `.history-fail-reason` rule (reset the
  inherited `white-space: nowrap` so the reason wraps).
