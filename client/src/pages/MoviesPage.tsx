import { useEffect, useState } from 'react';
import { Search, RefreshCw, Plus, Download, Trash2, Film } from 'lucide-react';
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
  movieFile?: { quality?: { quality?: { name: string } }; size: number; relativePath?: string };
  tmdbId?: number;
  imdbId?: string;
}

type AddState = 'idle' | 'adding' | 'added' | 'already' | 'error';

type RemuxStage = 'probing' | 'remuxing' | 'verifying' | 'importing' | 'done' | 'failed';

interface RemuxJob {
  movieId: number;
  stage: RemuxStage;
  percent: number | null;
  message: string | null;
}

interface RemuxStatus {
  ffmpeg: { ok: boolean; hint: string | null };
  job: RemuxJob | null;
}

const isDiscImage = (m: Movie) => /\.(iso|img)$/i.test(m.movieFile?.relativePath ?? '');
const isActive = (j: RemuxJob | null | undefined) => !!j && j.stage !== 'done' && j.stage !== 'failed';

function remuxLabel(j: RemuxJob): string {
  switch (j.stage) {
    case 'probing': return 'Reading disc…';
    case 'remuxing': return `Converting ${j.percent ?? 0}%`;
    case 'verifying': return 'Checking…';
    case 'importing': return 'Importing…';
    case 'done': return 'Converted for Plex';
    case 'failed': return 'Conversion failed';
  }
}

export default function MoviesPage() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searching, setSearching] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [remux, setRemux] = useState<RemuxStatus | null>(null);

  // Add movie states
  const [showAddModal, setShowAddModal] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [addSearching, setAddSearching] = useState(false);
  const [addState, setAddState] = useState<Record<number, AddState>>({});

  useEffect(() => {
    fetchMovies();
    fetchRemux();
  }, []);

  // Poll only while a conversion runs. A poll that sees the job finish as
  // 'done' refetches movies (the disc-image badge goes away); a 'done' job
  // already in memory on mount does not trigger a refetch.
  const remuxActive = isActive(remux?.job);
  useEffect(() => {
    if (!remuxActive) return;
    const t = setInterval(async () => {
      try {
        const res = await api.get('/system/remux');
        // job === null while one was running = the server restarted and lost it;
        // say so instead of silently resetting the card.
        setRemux((prev) =>
          res.data?.job || !prev?.job
            ? res.data
            : {
                ...res.data,
                job: {
                  ...prev.job,
                  stage: 'failed',
                  percent: null,
                  message: 'Interrupted: the server restarted. If the Disc image badge is still shown, run it again.',
                },
              },
        );
        if (res.data?.job?.stage === 'done' || !res.data?.job) {
          // Quiet refetch: fetchMovies() flips `loading`, which blanks the grid and loses the scroll position.
          // Covers both a normal finish and a restart during 'importing' — Radarr may have completed the swap anyway.
          api.get('/radarr/movie').then((r) => { if (Array.isArray(r.data)) setMovies(r.data); }).catch(() => {});
        }
      } catch {
        /* transient poll failure — keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [remuxActive]);

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

  const fetchRemux = async () => {
    try {
      const res = await api.get('/system/remux');
      setRemux(res.data);
    } catch {
      setRemux({ ffmpeg: { ok: false, hint: 'Could not check the conversion status (reload to retry)' }, job: null });
    }
  };

  // Remux the disc's main feature into an MKV Plex can play; the server swaps
  // it in for the disc image through Radarr once it checks out.
  const convertMovie = async (m: Movie) => {
    if (
      !window.confirm(
        `Convert "${m.title} (${m.year})" for Plex?\n\n` +
          "The disc's main feature is copied into an MKV (no quality loss). If it checks out, " +
          'Radarr replaces the disc image with it. This can take 10–40 minutes.',
      )
    ) return;
    try {
      const res = await api.post('/system/remux', { movieId: m.id });
      setRemux((prev) => ({ ffmpeg: prev?.ffmpeg ?? { ok: true, hint: null }, job: res.data.job }));
    } catch (err) {
      window.alert(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not start the conversion',
      );
      fetchRemux(); // e.g. a 409: pick up the job that is already running
    }
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

  // Delete the movie AND its files from Radarr. No import exclusion is set, so
  // adding it again later (Add button, or a Search grab) works exactly as today.
  const removeMovie = async (m: Movie) => {
    if (!window.confirm(`Remove "${m.title} (${m.year})" from Radarr and delete its files from disk?`)) return;
    setRemoving(m.id);
    try {
      await api.delete(`/radarr/movie/${m.id}`, { params: { deleteFiles: 'true' } });
      setMovies((prev) => prev.filter((x) => x.id !== m.id));
    } catch (err) {
      window.alert(`Remove failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setRemoving(null);
  };

  const searchForMovie = async () => {
    if (!addQuery.trim()) return;
    setAddState({});
    setSearchResults([]);
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

  const addMovie = async (r: Movie, i: number) => {
    setAddState((p) => ({ ...p, [i]: 'adding' }));
    try {
      const res = await api.post('/radarr/add-movie', { tmdbId: r.tmdbId, imdbId: r.imdbId });
      const added = res.data?.added === true;
      setAddState((p) => ({ ...p, [i]: added ? 'added' : 'already' }));
      if (added) fetchMovies();
    } catch {
      setAddState((p) => ({ ...p, [i]: 'error' }));
    }
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
          <button onClick={() => { setShowAddModal(true); setAddState({}); setSearchResults([]); setAddQuery(''); }} className="btn-primary">
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
          {filtered.map((m) => {
            const disc = isDiscImage(m);
            const myJob = remux?.job?.movieId === m.id ? remux.job : null;
            const converting = isActive(myJob);
            return (
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
                      disabled={searching === m.id || converting}
                    >
                      <Download size={14} />
                      {searching === m.id ? 'Searching...' : 'Search'}
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() => removeMovie(m)}
                      disabled={removing === m.id || converting}
                      title="Remove from Radarr and delete files"
                    >
                      <Trash2 size={14} />
                      {removing === m.id ? 'Removing...' : 'Remove'}
                    </button>
                    {disc && (
                      <button
                        className="btn-sm"
                        onClick={() => convertMovie(m)}
                        disabled={remuxActive || !remux?.ffmpeg.ok}
                        title={
                          remux?.ffmpeg.ok
                            ? 'Remux the disc into an MKV Plex can play'
                            : remux?.ffmpeg.hint ?? 'Checking for ffmpeg…'
                        }
                      >
                        <Film size={14} />
                        {converting && myJob ? remuxLabel(myJob) : 'Convert for Plex'}
                      </button>
                    )}
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
                    {disc && (
                      <>
                        {' '}&middot;{' '}
                        <span className="badge badge-warning" title="Plex can't play disc images">
                          Disc image
                        </span>
                      </>
                    )}
                  </div>
                  {myJob && (
                    <div className={`movie-remux${myJob.stage === 'failed' ? ' failed' : ''}`} role="status">
                      {remuxLabel(myJob)}
                      {myJob.message ? ` — ${myJob.message}` : ''}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
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
              {searchResults.map((r, i) => {
                const st = addState[i] ?? 'idle';
                return (
                  <div key={i} className="search-result-item">
                    <span>{r.title} ({r.year})</span>
                    <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {st === 'adding' && <span className="placeholder">Adding…</span>}
                      {st === 'added' && <span className="badge badge-success">Added — searching</span>}
                      {st === 'already' && <span className="badge badge-warning">Already in library</span>}
                      {st === 'error' && <span className="badge badge-danger">Error</span>}
                      {(st === 'idle' || st === 'error') && (
                        <button className="btn-sm btn-primary" onClick={() => addMovie(r, i)}>Add</button>
                      )}
                    </div>
                  </div>
                );
              })}
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
