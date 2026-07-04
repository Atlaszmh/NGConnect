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
