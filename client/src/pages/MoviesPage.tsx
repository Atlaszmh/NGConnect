import { useEffect, useState } from 'react';
import { Search, RefreshCw, Plus, Download } from 'lucide-react';
import api from '../services/api';

interface Movie {
  id: number;
  title: string;
  year: number;
  overview: string;
  monitored: boolean;
  hasFile: boolean;
  status: string;
  images: { coverType: string; remoteUrl?: string; url?: string }[];
  sizeOnDisk?: number;
  movieFile?: { quality?: { quality?: { name: string } }; size: number };
}

export default function MoviesPage() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searching, setSearching] = useState<number | null>(null);

  // Add movie states
  const [showAddModal, setShowAddModal] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [addSearching, setAddSearching] = useState(false);

  useEffect(() => {
    fetchMovies();
  }, []);

  const fetchMovies = async () => {
    setLoading(true);
    try {
      const res = await api.get('/radarr/movie');
      setMovies(Array.isArray(res.data) ? res.data : []);
    } catch {
      setMovies([]);
    }
    setLoading(false);
  };

  const triggerSearch = async (movieId: number) => {
    setSearching(movieId);
    try {
      await api.post('/radarr/command', {
        name: 'MoviesSearch',
        movieIds: [movieId],
      });
    } catch {
      // Search command sent
    }
    setTimeout(() => setSearching(null), 2000);
  };

  const searchForMovie = async () => {
    if (!addQuery.trim()) return;
    setAddSearching(true);
    try {
      const res = await api.get('/radarr/movie/lookup', {
        params: { term: addQuery },
      });
      setSearchResults(Array.isArray(res.data) ? res.data : []);
    } catch {
      setSearchResults([]);
    }
    setAddSearching(false);
  };

  const getPoster = (m: Movie) => {
    const poster = m.images?.find((i) => i.coverType === 'poster');
    return poster?.remoteUrl || poster?.url || '';
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  };

  const filtered = movies.filter((m) => {
    const matchesText = m.title.toLowerCase().includes(filter.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'downloaded' && m.hasFile) ||
      (statusFilter === 'missing' && !m.hasFile && m.monitored) ||
      (statusFilter === 'unmonitored' && !m.monitored);
    return matchesText && matchesStatus;
  });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Movies</h2>
        <div className="header-actions">
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <Plus size={16} /> Add Movie
          </button>
          <button className="btn-icon" onClick={fetchMovies} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Search size={16} />
          <input
            type="text"
            placeholder="Filter movies..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All</option>
          <option value="downloaded">Downloaded</option>
          <option value="missing">Missing</option>
          <option value="unmonitored">Unmonitored</option>
        </select>
        <span className="count">{filtered.length} movies</span>
      </div>

      {loading ? (
        <p className="placeholder">Loading movies from Radarr...</p>
      ) : filtered.length === 0 ? (
        <p className="placeholder">
          {movies.length === 0
            ? 'No movies found. Connect Radarr and add movies to get started.'
            : 'No movies match your filter.'}
        </p>
      ) : (
        <div className="movie-grid">
          {filtered.map((m) => (
            <div key={m.id} className="movie-card">
              <div className="movie-poster-wrap">
                {getPoster(m) ? (
                  <img
                    className="movie-poster"
                    src={getPoster(m)}
                    alt={m.title}
                  />
                ) : (
                  <div className="movie-poster-placeholder">{m.title[0]}</div>
                )}
                <div className="movie-overlay">
                  <button
                    className="btn-sm"
                    onClick={() => triggerSearch(m.id)}
                    disabled={searching === m.id}
                  >
                    <Download size={14} />
                    {searching === m.id ? 'Searching...' : 'Search'}
                  </button>
                </div>
              </div>
              <div className="movie-info">
                <div className="movie-title">{m.title}</div>
                <div className="movie-meta">
                  {m.year}
                  {m.hasFile && (
                    <>
                      {' '}&middot;{' '}
                      <span className="badge badge-success">Downloaded</span>
                      {m.sizeOnDisk ? ` ${formatSize(m.sizeOnDisk)}` : ''}
                    </>
                  )}
                  {!m.hasFile && m.monitored && (
                    <>
                      {' '}&middot;{' '}
                      <span className="badge badge-warning">Missing</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Movie Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Movie</h3>
            <div className="search-input">
              <Search size={16} />
              <input
                type="text"
                placeholder="Search for a movie..."
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchForMovie()}
              />
              <button onClick={searchForMovie} disabled={addSearching}>
                {addSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div key={i} className="search-result-item">
                  <span>
                    {r.title} ({r.year})
                  </span>
                  <span className="placeholder">
                    {r.overview?.slice(0, 100)}...
                  </span>
                </div>
              ))}
            </div>
            <button className="btn-close" onClick={() => setShowAddModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
