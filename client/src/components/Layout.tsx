import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Tv,
  Film,
  Download,
  Search,
  Shield,
  Settings,
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
  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>NGConnect</h1>
        </div>
        <ul className="nav-list">
          {navItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
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
      <main className="main-content">
        <StatusBar />
        <Outlet />
      </main>
    </div>
  );
}
