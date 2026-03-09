import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import TvShowsPage from './pages/TvShowsPage';
import MoviesPage from './pages/MoviesPage';
import DownloadsPage from './pages/DownloadsPage';
import SearchPage from './pages/SearchPage';
import VpnPage from './pages/VpnPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import api from './services/api';
import { isAuthenticated } from './services/auth';

// Initialize auth interceptors
import './services/auth';

export default function App() {
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [loggedIn, setLoggedIn] = useState(isAuthenticated());

  useEffect(() => {
    api
      .get('/auth/check')
      .then((res) => {
        setAuthRequired(res.data.authEnabled);
      })
      .catch(() => {
        setAuthRequired(false);
      });
  }, []);

  // Still checking auth status
  if (authRequired === null) return null;

  // Auth required and not logged in
  if (authRequired && !loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/tv" element={<TvShowsPage />} />
          <Route path="/movies" element={<MoviesPage />} />
          <Route path="/downloads" element={<DownloadsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/vpn" element={<VpnPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
