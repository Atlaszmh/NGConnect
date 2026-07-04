# Mobile-Friendly Client Pass Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole NGConnect client comfortably usable on phones (~360px+) via a hamburger-drawer mobile nav plus a responsive CSS sweep, without changing desktop.

**Architecture:** One small `Layout.tsx` change adds a mobile top bar + off-canvas drawer nav (toggled by a `drawerOpen` boolean); everything else is CSS in `client/src/index.css`. Table containers get horizontal-scroll wrappers + a global no-sideways-scroll guard; flex rows wrap, tap targets grow, and a `≤480px` tier is added. Every mobile-only rule is scoped inside `@media (max-width: …)` (or an additive element hidden on desktop) so ≥769px rendering is untouched.

**Tech Stack:** React 19 + Vite + TypeScript (strict, `noUnusedLocals`, `verbatimModuleSyntax`), hand-written CSS in a single `index.css`. No client test harness — `npm run build` (tsc -b && vite build) is the only automated gate; layout is verified by a USER-RUN device pass.

**Spec:** [docs/superpowers/specs/2026-07-04-mobile-responsive-design.md](../specs/2026-07-04-mobile-responsive-design.md)

**Branch:** `feature/mobile-responsive` (already checked out). NOT merged to `main` until the end.

---

## Note on testing (read first)

This feature is CSS + one component. There is **no client unit-test harness**, and layout/responsiveness cannot be meaningfully unit-tested. So each task's automated gate is **`cd client && npm run build`** (catches TS errors and CSS that breaks the build). The **real** verification is the USER-RUN device pass in the final task. Do NOT invent a test framework or snapshot tests — that's out of scope. Commit after each task once the build is clean.

---

## File Structure

**Modified:**
- `client/src/components/Layout.tsx` — add the mobile top bar (hamburger + title + a `NotificationBell`), `drawerOpen` state, the `open` class on the nav, the overlay, and close-on-nav-click. Second responsibility stays the same (it's still just the app shell).
- `client/src/index.css` — (a) nav: base `.mobile-topbar`/`.drawer-overlay` (hidden on desktop) + a rewritten `@media (max-width:768px)` nav block; (b) responsive sweep: global table-scroll wrappers + overflow guard, plus `≤768px`/`≤480px` rules for wrapping rows, tap targets, padding, the notification-drawer cap/reposition, and the poster grid.

**Unchanged (already responsive — do NOT touch):** `.modal`, `.login-form`, `.movie-grid` base, `.card-grid` base.

---

## Chunk 1: Mobile navigation (top bar + drawer)

### Task 1: `Layout.tsx` — top bar, drawer state, overlay

**Files:**
- Modify: `client/src/components/Layout.tsx`

- [ ] **Step 1: Replace the component with the drawer-enabled version**

Replace the entire contents of `client/src/components/Layout.tsx` with:

```tsx
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Tv,
  Film,
  Download,
  Search,
  Shield,
  Settings,
  Menu,
} from 'lucide-react';
import NotificationBell from './NotificationBell';
import StatusBar from './StatusBar';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/tv', icon: Tv, label: 'TV Shows' },
  { to: '/movies', icon: Film, label: 'Movies' },
  { to: '/downloads', icon: Download, label: 'Downloads' },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/vpn', icon: Shield, label: 'VPN' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="app-layout">
      {/* Mobile top bar — hidden on desktop via CSS */}
      <header className="mobile-topbar">
        <button
          className="topbar-hamburger btn-icon"
          onClick={() => setDrawerOpen((o) => !o)}
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </button>
        <h1 className="topbar-title">NGConnect</h1>
        <NotificationBell />
      </header>

      {/* Nav — fixed sidebar on desktop, off-canvas drawer on mobile */}
      <nav className={`sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h1>NGConnect</h1>
        </div>
        <ul className="nav-list">
          {navItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                onClick={closeDrawer}
                className={({ isActive }) =>
                  `nav-link ${isActive ? 'active' : ''}`
                }
              >
                <Icon size={20} />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <NotificationBell />
        </div>
      </nav>

      {/* Dimmed overlay behind the drawer — mobile only, only when open */}
      {drawerOpen && <div className="drawer-overlay" onClick={closeDrawer} />}

      <main className="main-content">
        <StatusBar />
        <Outlet />
      </main>
    </div>
  );
}
```

Key points: `Menu` and `useState` are both imported and used (so `noUnusedLocals`/`verbatimModuleSyntax` stay clean); two `NotificationBell` instances (top bar + footer) — CSS shows exactly one per breakpoint; every `NavLink` closes the drawer on click.

- [ ] **Step 2: Build**

Run: `cd client && npm run build`
Expected: `tsc -b && vite build` — no type errors (in particular no "unused" error for `Menu`/`useState`); `client/dist` produced.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Layout.tsx
git commit -m "feat(client): mobile top bar + drawer nav scaffolding in Layout"
```

(After this task the mobile CSS isn't written yet, so on a narrow screen the new elements render unstyled — that's expected; Task 2 styles them. Desktop is unaffected because `.mobile-topbar`/`.drawer-overlay` get `display:none` in Task 2, and until then they render but are harmless.)

---

### Task 2: Nav CSS — top bar, off-canvas drawer, overlay, z-index ladder

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Add base (desktop) rules that hide the mobile-only elements**

Insert these rules right AFTER the `.main-content` rule (currently ends at `index.css:97`), so the mobile-only elements are hidden by default on desktop:

```css
/* Mobile-only nav elements — shown only under the mobile breakpoint (see @media below) */
.mobile-topbar {
  display: none;
}
.drawer-overlay {
  display: none;
}
```

- [ ] **Step 2: Replace the existing mobile media block**

Replace the existing block at `index.css:1267-1292` (the `@media (max-width: 768px) { … }` that shrinks the sidebar to a 60px rail) **entirely** with:

```css
@media (max-width: 768px) {
  /* --- Mobile top bar --- */
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 52px;
    padding: 0 12px;
    background-color: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    z-index: 150;
  }
  .topbar-title {
    flex: 1;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--color-accent);
    letter-spacing: -0.5px;
  }

  /* --- Sidebar becomes an off-canvas drawer --- */
  .sidebar {
    width: min(80vw, 280px);
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    z-index: 250; /* above the overlay */
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .nav-link span {
    display: inline; /* labels visible in the drawer */
  }

  /* --- Dimmed overlay (between content and drawer) --- */
  .drawer-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 200;
  }

  /* --- Content full-width, clear the fixed top bar --- */
  .main-content {
    margin-left: 0;
    padding: 16px;
    padding-top: 68px; /* 52px top bar + 16px breathing room */
  }

  /* Only the top-bar bell shows on mobile; hide the footer bell */
  .sidebar-footer {
    display: none;
  }

  /* Notification popover: anchored to the top-bar bell, open downward + capped */
  .mobile-topbar .notification-drawer {
    top: 100%;
    bottom: auto;
    left: auto;
    right: 0;
    width: min(320px, calc(100vw - 24px));
  }

  /* Preserved from the old block */
  .card-grid {
    grid-template-columns: 1fr;
  }
}
```

Z-index ladder (explicit): content (base) < `.mobile-topbar` (150) < `.drawer-overlay` (200) < `.sidebar.open` (250); the existing `.notification-drawer` (z-index 300) still floats above, which is correct for the top-bar popover.

Note: the base `.sidebar` rule (`position: fixed; width: 220px; z-index: 100`, `index.css:39`) is UNCHANGED — desktop still renders the full sidebar. The `.open` class does nothing on desktop because the `transform` rules live only inside this media query.

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: build clean; `client/dist` produced. (No TS involved in CSS, but this confirms the stylesheet still parses and bundles.)

- [ ] **Step 4: Commit**

```bash
git add client/src/index.css
git commit -m "feat(client): mobile top bar + off-canvas drawer nav CSS"
```

---

## Chunk 2: Responsive CSS sweep

### Task 3: Tables never break the page (scroll wrappers + overflow guard)

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Add the global overflow guard + table scroll containers**

Append to `client/src/index.css` (these are safe on desktop too — a non-overflowing table is unaffected):

```css
/* --- Never let the page scroll sideways --- */
html,
body {
  max-width: 100%;
  overflow-x: hidden;
}

/* --- Wide tables scroll within their own box, not the page --- */
.search-results-table,
.history-list,
.episodes-panel {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

- [ ] **Step 2: On mobile, give the tables a readable min-width so they scroll instead of cramming**

Append a mobile block:

```css
@media (max-width: 768px) {
  .search-results-table .data-table,
  .history-list .data-table,
  .episodes-panel .episode-table {
    min-width: 560px;
  }
}
```

(This makes the 6-column tables scroll horizontally inside their container at phone widths instead of squishing columns to unreadable widths. The container's `overflow-x: auto` from Step 1 provides the scroll.)

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: build clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/index.css
git commit -m "feat(client): horizontal-scroll table containers + no-sideways-page-scroll guard"
```

---

### Task 4: Responsive sweep — wrapping rows, tap targets, padding, popover cap, poster grid

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Append the `≤768px` sweep rules**

Append to `client/src/index.css`:

```css
@media (max-width: 768px) {
  /* Flex rows wrap/stack instead of overflowing */
  .search-bar {
    flex-wrap: wrap;
  }
  .search-bar .search-input,
  .search-bar .search-input.large {
    flex: 1 1 100%;
  }
  .page-header {
    flex-wrap: wrap;
    gap: 12px;
  }
  .header-actions,
  .page-header-actions {
    flex-wrap: wrap;
  }
  .stats-bar {
    flex-wrap: wrap;
    gap: 12px 20px;
  }

  /* Comfortable tap targets (~44px) */
  .nav-link {
    padding: 12px;
    min-height: 44px;
  }
  .btn,
  .btn-primary,
  .btn-icon,
  .tab {
    min-height: 44px;
  }
  .btn-sm {
    min-height: 36px;
  }
}
```

Notes: `.search-input` base is `flex: 1; max-width: 400px` (`index.css:246`); the `flex: 1 1 100%` override makes it take the full row on mobile so the category `<select>` and Search button drop below it. `.btn`/`.btn-primary`/`.btn-icon`/`.tab` get 44px; `.btn-sm` (dense table-action buttons) gets a slightly smaller 36px so grab-action clusters don't get huge — still an easier target than the 0.75rem default.

- [ ] **Step 2: Append the `≤480px` phone tier**

Append to `client/src/index.css`:

```css
@media (max-width: 480px) {
  .main-content {
    padding: 14px;
    padding-top: 66px; /* 52px top bar + 14px */
  }
  .modal {
    padding: 16px;
  }
  .page h2 {
    font-size: 1.25rem;
    margin-bottom: 16px;
  }
  /* Keep posters 2-up with the gap on the narrowest phones */
  .movie-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
  }
}
```

- [ ] **Step 3: Build**

Run: `cd client && npm run build`
Expected: build clean; `client/dist` produced.

- [ ] **Step 4: Commit**

```bash
git add client/src/index.css
git commit -m "feat(client): responsive sweep — wrapping rows, tap targets, phone tier"
```

---

## Chunk 3: Verification and rollout

### Task 5: Verify, merge, USER-RUN device pass

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /c/Projects/NGConnect/client && npm run build
```
Expected: `tsc -b && vite build` exits 0, `client/dist` produced, no type errors.

(There are no server changes and no committed secrets in this feature, so the server test suite and key-scan aren't needed — but a quick `git diff --stat main..HEAD` should show ONLY `client/src/components/Layout.tsx`, `client/src/index.css`, and the two docs files.)

- [ ] **Step 2: Confirm no divergence, then merge and push**

`origin/main` has moved under feature branches before — check first:
```bash
cd /c/Projects/NGConnect
git fetch origin
git log --oneline HEAD..origin/main   # expect EMPTY
git checkout main
git merge --ff-only origin/main
git merge --no-ff feature/mobile-responsive -m "feat: mobile-friendly client (hamburger drawer nav + responsive CSS)"
(cd client && npm run build) && git push origin main
```
Expected: `HEAD..origin/main` empty; merged build clean; push succeeds. Server PC auto-deploys within the hour (or via "Check for Updates Now").

- [ ] **Step 3: USER-RUN — device pass** (layout can't be unit-tested)

On a phone (or browser devtools at 360 / 390 / 414px widths), confirm:
- **Nav drawer:** hamburger opens the drawer with full labels; tapping a nav link navigates AND closes the drawer; tapping the dimmed overlay closes it; the top bar shows the title + a working notification bell (opens downward, stays on-screen).
- **No sideways page scroll on any route:** Dashboard, TV Shows, Movies, Downloads (Queue + History tabs), Search, VPN, Settings.
- **Tables scroll in their own box** (not the page): Search results, Downloads → History, and — **expand a TV show** — the episode table.
- **Readable text, tappable controls (~44px)** everywhere; the Downloads Queue/History **tab row** still sits flush on its underline.
- **Modals** (Add Show / Add Movie) fit the screen; the season checklist and grab buttons wrap.
- **Desktop unchanged:** at ≥769px the full sidebar, layouts, and notification bell look exactly as before (no top bar, no overlay).

---

## Done criteria

- [ ] `Layout.tsx` renders a mobile top bar + off-canvas drawer (state-toggled, closes on nav/overlay); strict-TS clean.
- [ ] All mobile rules live inside `@media (max-width: …)` or additive elements hidden on desktop; ≥769px rendering is untouched.
- [ ] The three wide tables scroll within their own containers; the page never scrolls sideways on any route at ~360px.
- [ ] Flex rows wrap, tap targets ~44px, notification popover capped/repositioned, poster grid stays 2-up on phones.
- [ ] `client` build clean; merged to main and pushed.
- [ ] Live device pass: every route usable on a phone; desktop unchanged.
