# Mobile-Friendly Client Pass — Design Spec

**Date:** 2026-07-04
**Status:** Approved
**Author:** Zach + Claude

## Problem

NGConnect's client was built desktop-first. The only responsive treatment today
is a single `@media (max-width: 768px)` block that shrinks the fixed sidebar to a
60px icon-only rail and collapses `.card-grid` to one column. On a phone
(~360–414px wide) the app is awkward: the data tables (Search results, Downloads
history — 6 columns each) overflow the viewport and make the **whole page scroll
sideways**; flex rows (search bar, page headers, stat bars) crowd; tap targets are
small; and the permanent 60px label-less rail wastes horizontal space. The goal is
a focused responsive pass so the whole client is comfortably usable on phones.

## Goals

- The app is **comfortable and fully usable down to ~360px wide**: no horizontal
  page scroll, readable text, tappable controls, working navigation.
- **Mobile navigation via a hamburger drawer** (approved): a slim top bar with a
  hamburger + title + notification bell; the existing nav slides in as an
  off-canvas drawer with full labels over a dimmed overlay; content is full-width.
- **Desktop/tablet ≥768px is visually unchanged** — every new rule is scoped inside
  mobile media queries.
- No functional/logic changes, no new dependencies.

## Non-Goals

- Restructuring data tables into stacked "card" rows (horizontal-scroll containers
  are enough for now; a card rebuild can be a later, separate effort).
- Any change to page behavior, data fetching, routing targets, or the API.
- A component/CSS framework migration (Tailwind, etc.) or a design-token overhaul.
- Native-app concerns (PWA/install, offline, touch gestures beyond tap).
- The two other queued efforts (Search-result persistence; the grab-after-cancel
  bug) — each is its own cycle.

## Context (current state)

- **Layout** (`client/src/components/Layout.tsx`): `.app-layout` (flex) → a
  `position: fixed` `.sidebar` (var `--sidebar-width: 220px`) + `.main-content`
  (`margin-left: 220px; padding: 24px 32px`). Nav is a `<ul class="nav-list">` of 7
  `NavLink`s; the `NotificationBell` sits in `.sidebar-footer`.
- **Existing breakpoint** (`index.css:1267`): `@media (max-width: 768px)` → sidebar
  60px, `.nav-link span { display:none }`, `.main-content { margin-left:60px;
  padding:16px }`, `.card-grid { grid-template-columns: 1fr }`.
- **Viewport meta is present** (`client/index.html:6`,
  `width=device-width, initial-scale=1.0`) — base mobile rendering works.
- **Tables** (`.episode-table, .data-table`, `index.css:590`): `width:100%`, font
  0.8rem, no scroll wrapper. Used by Search results (`SearchPage.tsx`, in a
  `.search-results-table` div) and Downloads history (`DownloadsPage.tsx`, in a
  `.history-list` div) — neither wrapper sets `overflow-x`. `.name-cell` truncates
  at `max-width:400px`.
- **Already responsive (leave alone):** `.modal` (`width:90%; max-width:560px`),
  `.login-form` (`width:360px; max-width:90%`), `.movie-grid`
  (`repeat(auto-fill, minmax(160px,1fr))` → ~2-up on phones), `.card-grid`.
- **Needs a viewport cap:** `.notification-drawer` (`index.css:1013`) is a fixed
  `width:320px` popover anchored `bottom:100%; left:0` to the bell — can exceed a
  narrow screen and, once the bell moves to the top bar, needs repositioning.
- Client is React 19 + Vite + TypeScript strict (`noUnusedLocals`,
  `verbatimModuleSyntax`); styling is hand-written CSS in one `index.css`. No client
  test harness — `npm run build` is the gate.

## Architecture Overview

Two units of work: (1) a small **`Layout.tsx` + CSS** change introducing the mobile
top bar + drawer nav; (2) a **CSS-only responsive sweep** of the remaining pain
points, all inside mobile media queries. Breakpoint strategy: keep the existing
**`≤768px`** tier (now hosting the drawer nav, table scroll wrappers, wrapping
rows) and add a tighter **`≤480px`** phone tier (padding, tap targets, finer
stacking). Desktop CSS is not touched.

## Component 1: Mobile navigation — top bar + drawer (`Layout.tsx` + CSS)

- **`Layout.tsx`:** add a `drawerOpen` state (`useState(false)`). Render (always in
  the DOM; shown/hidden by CSS at the breakpoint):
  - a `.mobile-topbar` containing a hamburger button (`Menu` icon from
    `lucide-react`, toggles `drawerOpen`), the "NGConnect" title, and the existing
    `<NotificationBell />`;
  - the existing `<nav class="sidebar">` gains a conditional `open` class
    (`sidebar ${drawerOpen ? 'open' : ''}`);
  - a `.drawer-overlay` div (rendered when `drawerOpen`) that closes the drawer on
    click;
  - close the drawer on nav-link click (`onClick` on the `NavLink`s sets
    `drawerOpen(false)`) so navigating dismisses it.
  **NotificationBell placement (decided for v1):** render **two** `<NotificationBell/>`
  instances — one in the new `.mobile-topbar`, one in the existing `.sidebar-footer` —
  and let CSS show exactly one per breakpoint (footer visible ≥769px, top-bar
  visible ≤768px). Both mount, so both run the bell's `setInterval(fetchCount,
  10000)` + mount fetch + `document` mousedown listener; on a personal LAN dashboard
  polling every 10s this 2× cost is negligible and is the chosen tradeoff for
  simple JSX. (Fallback, only if this ever matters: a single instance gated by a
  JS media-query hook — deliberately NOT done for v1.)
- **CSS:**
  - `.mobile-topbar`: hidden on desktop (`display:none`), shown `flex` at ≤768px;
    fixed top, full width, height ~52px, holds hamburger/title/bell, `z-index`
    above content and below the drawer.
  - At ≤768px: `.sidebar` becomes an off-canvas drawer — full-height, its natural
    width (220px) or `min(80vw, 280px)`, `transform: translateX(-100%)` by default,
    `transform: translateX(0)` when `.open`, with a `transition`; `z-index` above
    the overlay. Restore `.nav-link span { display: inline }` (labels visible in the
    drawer) — overriding the old icon-rail rule, which is removed.
  - `.drawer-overlay`: fixed full-screen dim (`rgba(0,0,0,.5)`), `z-index` between
    content and drawer, only present when open.
  - `.main-content` at ≤768px: `margin-left: 0`, top padding increased to clear the
    fixed top bar (`padding-top` ≈ 52px + spacing).
  - The old ≤768px sidebar-rail rules (`.sidebar { width:60px }`,
    `.sidebar-header h1 { font-size:0 }`, `.nav-link span { display:none }`,
    `.main-content { margin-left:60px }`) are replaced by the drawer rules.
  - **Z-index ladder** (make it explicit so nothing guesses): content (base) <
    `.mobile-topbar` < `.drawer-overlay` < `.sidebar.open` (nav drawer). The
    existing `.notification-drawer` (`z-index:300`) opens from the top-bar bell and
    should sit above the top bar but need not fight the nav drawer (the two aren't
    open in a conflicting way). Assign concrete values in that order during
    implementation.
  - **Outside-click note (not a bug):** `NotificationBell` closes its own popover on
    any `document` mousedown. When the nav `.drawer-overlay` is tapped, that
    mousedown also closes an open notification popover — harmless and expected. Do
    NOT add `stopPropagation` on the overlay (it would break the bell's
    close-on-outside-click); just let both close.

## Component 2: CSS responsive sweep (all inside mobile media queries)

- **Tables never break the page:** wrap the table containers so they scroll
  horizontally within their own box (`overflow-x: auto; -webkit-overflow-scrolling:
  touch`). There are **three** table containers to cover: `.search-results-table`
  (`SearchPage.tsx`), `.history-list` (`DownloadsPage.tsx`), **and `.episodes-panel`**
  (`index.css:585`, the `.episode-table` shown when a TV show is expanded on
  `TvShowsPage.tsx`). Add a global guard so the page body never scrolls sideways
  (e.g. `html, body { max-width: 100%; overflow-x: hidden }` — verified not to clip
  the fixed drawer/overlay, which are `position:fixed` and unaffected).
- **Flex rows stack/wrap** at ≤768px (or ≤480 where finer): `.search-bar`
  (`flex-wrap: wrap`, input full-width), `.page-header` (title above actions;
  `flex-wrap: wrap`), `.header-actions`/`.page-header-actions` (`flex-wrap: wrap`),
  `.stats-bar` (`flex-wrap: wrap`), and the inline `grab-actions` clusters already
  use `flex-wrap`.
- **Tap targets** at ≤768px: `.nav-link`, `.btn`, `.btn-sm`, `.btn-icon`,
  `.btn-icon-sm`, `.tab` get `min-height: 44px` (and matching vertical padding);
  the drawer nav links are comfortably tall.
- **Padding/spacing:** `.main-content` padding trimmed to ~14–16px at ≤480; `.modal`
  padding reduced on phones; `.page h2` slightly smaller.
- **Popover cap:** `.notification-drawer` → `width: min(320px, calc(100vw - 24px))`,
  and at ≤768px reposition so it opens from the top bar without going off-screen
  (e.g. `right: 8px; left: auto` anchored under the top-bar bell). Exact anchoring
  finalized in implementation against the bell's mobile position.
- **Poster grid:** `.movie-grid` at ≤480 → `minmax(140px, 1fr)` so 2-up stays
  reliable with the gap on the narrowest phones.

## Data Flow

N/A — no data or state flow changes beyond the `drawerOpen` boolean local to
`Layout.tsx`. All other changes are presentational CSS.

## Error Handling

N/A (no new failure modes). The drawer defaults closed; if JS/state fails the app
still renders content (drawer just won't open). CSS is additive and scoped to
mobile widths, so a bad rule degrades gracefully to the desktop layout.

## Testing Strategy

- **Build gate:** `cd client && npm run build` (tsc -b && vite build) — the
  `Layout.tsx` change must stay strict-TS clean (`noUnusedLocals`,
  `verbatimModuleSyntax`; the new `Menu` import must be used).
- **USER-RUN device pass** (the real verification — layout can't be unit-tested):
  on a phone (or browser devtools at 360/390/414px), walk every route —
  **Dashboard, TV Shows, Movies, Downloads (Queue + History tabs), Search, VPN,
  Settings**, plus the **Add Show / Add Movie modals** and the **notification
  drawer** — and confirm for each: no horizontal page scroll, text readable without
  zoom, all controls tappable (~44px), tables scroll within their own box, and the
  **hamburger drawer** opens/closes (hamburger, overlay tap, and nav-link tap) and
  navigates correctly. Specific spots that are easy to miss: **expand a TV show** and
  confirm the **episode table** scrolls in its own box (not the page); and check the
  **Downloads Queue/History tab row** still sits flush on its underline after the
  `.tab` tap-target bump. Also confirm **desktop is unchanged** at ≥769px.
- Regression focus: desktop sidebar/lay­out at ≥769px (all new rules must be inside
  `max-width` queries), and that the notification drawer still works on desktop.

## Risks / Open Questions

- **Broad CSS regressing desktop.** Mitigation: every new/changed rule lives inside
  a `max-width` media query (or is a strictly additive class like `.mobile-topbar`/
  `.drawer-overlay` hidden on desktop); build + desktop spot-check.
- **Double-mounted `NotificationBell`** (top bar + footer, one hidden per
  breakpoint). Both mount and run their 10s polling hooks + mousedown listener —
  **decided acceptable for v1** (negligible on a personal LAN app; see Component 1).
  Fallback documented if it ever matters.
- **`overflow-x: hidden` on body** could in theory clip a legitimately-wide element;
  verified the only intentionally-wide elements (tables) get their own scroll
  container, and fixed-position drawer/overlay are exempt.
- **Notification-drawer anchoring on mobile** (bell moves to the top bar) — exact
  `left/right/top` finalized against the real rendered position during
  implementation and confirmed in the device pass.

## Files Touched

**New:**
- `docs/superpowers/specs/2026-07-04-mobile-responsive-design.md` (this file).

**Modified:**
- `client/src/components/Layout.tsx` — mobile top bar, `drawerOpen` state, drawer
  `open` class + overlay, close-on-nav.
- `client/src/index.css` — the drawer/top-bar rules replacing the old icon-rail
  block, the responsive sweep (table scroll wrappers, wrapping rows, tap targets,
  padding, popover cap, poster grid), and the `≤480px` tier.
