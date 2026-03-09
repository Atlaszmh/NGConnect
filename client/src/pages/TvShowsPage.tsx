import { useEffect, useState } from 'react';
import { Search, RefreshCw, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import api from '../services/api';

interface Series {
  id: number;
  title: string;
  sortTitle: string;
  year: number;
  seasonCount: number;
  episodeCount: number;
  episodeFileCount: number;
  status: string;
  monitored: boolean;
  overview: string;
  images: { coverType: string; remoteUrl?: string; url?: string }[];
  statistics?: {
    episodeFileCount: number;
    episodeCount: number;
    percentOfEpisodes: number;
    sizeOnDisk: number;
  };
}

interface Episode {
  id: number;
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
  monitored: boolean;
  airDateUtc?: string;
}

export default function TvShowsPage() {
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [searching, setSearching] = useState<number | null>(null);

  // Add show states
  const [showAddModal, setShowAddModal] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Series[]>([]);
  const [addSearching, setAddSearching] = useState(false);

  useEffect(() => {
    fetchSeries();
  }, []);

  const fetchSeries = async () => {
    setLoading(true);
    try {
      const res = await api.get('/sonarr/series');
      setSeries(Array.isArray(res.data) ? res.data : []);
    } catch {
      setSeries([]);
    }
    setLoading(false);
  };

  const toggleExpand = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    try {
      const res = await api.get('/sonarr/episode', {
        params: { seriesId: id },
      });
      setEpisodes(Array.isArray(res.data) ? res.data : []);
    } catch {
      setEpisodes([]);
    }
  };

  const triggerSearch = async (seriesId: number) => {
    setSearching(seriesId);
    try {
      await api.post('/sonarr/command', {
        name: 'SeriesSearch',
        seriesId,
      });
    } catch {
      // Search command sent
    }
    setTimeout(() => setSearching(null), 2000);
  };

  const searchForShow = async () => {
    if (!addQuery.trim()) return;
    setAddSearching(true);
    try {
      const res = await api.get('/sonarr/series/lookup', {
        params: { term: addQuery },
      });
      setSearchResults(Array.isArray(res.data) ? res.data : []);
    } catch {
      setSearchResults([]);
    }
    setAddSearching(false);
  };

  const getPoster = (s: Series) => {
    const poster = s.images?.find((i) => i.coverType === 'poster');
    return poster?.remoteUrl || poster?.url || '';
  };

  const filtered = series.filter((s) =>
    s.title.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>TV Shows</h2>
        <div className="header-actions">
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <Plus size={16} /> Add Show
          </button>
          <button className="btn-icon" onClick={fetchSeries} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Search size={16} />
          <input
            type="text"
            placeholder="Filter shows..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <span className="count">{filtered.length} shows</span>
      </div>

      {loading ? (
        <p className="placeholder">Loading shows from Sonarr...</p>
      ) : filtered.length === 0 ? (
        <p className="placeholder">
          {series.length === 0
            ? 'No shows found. Connect Sonarr and add shows to get started.'
            : 'No shows match your filter.'}
        </p>
      ) : (
        <div className="series-list">
          {filtered.map((s) => {
            const pct =
              s.statistics?.percentOfEpisodes ??
              (s.episodeCount > 0
                ? (s.episodeFileCount / s.episodeCount) * 100
                : 0);
            const fileCount = s.statistics?.episodeFileCount ?? s.episodeFileCount;
            const totalCount = s.statistics?.episodeCount ?? s.episodeCount;

            return (
              <div key={s.id} className="series-card">
                <div className="series-row" onClick={() => toggleExpand(s.id)}>
                  {getPoster(s) && (
                    <img
                      className="series-poster"
                      src={getPoster(s)}
                      alt={s.title}
                    />
                  )}
                  <div className="series-info">
                    <div className="series-title">
                      {s.title}
                      <span className="series-year">({s.year})</span>
                      {!s.monitored && (
                        <span className="badge badge-muted">Unmonitored</span>
                      )}
                    </div>
                    <div className="series-meta">
                      {s.seasonCount} seasons &middot; {fileCount}/{totalCount}{' '}
                      episodes
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="series-actions">
                    <button
                      className="btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        triggerSearch(s.id);
                      }}
                      disabled={searching === s.id}
                    >
                      {searching === s.id ? 'Searching...' : 'Search Missing'}
                    </button>
                    {expandedId === s.id ? (
                      <ChevronUp size={16} />
                    ) : (
                      <ChevronDown size={16} />
                    )}
                  </div>
                </div>

                {expandedId === s.id && (
                  <div className="episodes-panel">
                    {episodes.length === 0 ? (
                      <p className="placeholder">Loading episodes...</p>
                    ) : (
                      <table className="episode-table">
                        <thead>
                          <tr>
                            <th>Episode</th>
                            <th>Title</th>
                            <th>Air Date</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {episodes
                            .sort(
                              (a, b) =>
                                b.seasonNumber - a.seasonNumber ||
                                b.episodeNumber - a.episodeNumber
                            )
                            .slice(0, 20)
                            .map((ep) => (
                              <tr key={ep.id}>
                                <td>
                                  S{String(ep.seasonNumber).padStart(2, '0')}E
                                  {String(ep.episodeNumber).padStart(2, '0')}
                                </td>
                                <td>{ep.title}</td>
                                <td>
                                  {ep.airDateUtc
                                    ? new Date(ep.airDateUtc).toLocaleDateString()
                                    : 'TBA'}
                                </td>
                                <td>
                                  {ep.hasFile ? (
                                    <span className="badge badge-success">
                                      Downloaded
                                    </span>
                                  ) : ep.monitored ? (
                                    <span className="badge badge-warning">
                                      Missing
                                    </span>
                                  ) : (
                                    <span className="badge badge-muted">
                                      Unmonitored
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Show Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add TV Show</h3>
            <div className="search-input">
              <Search size={16} />
              <input
                type="text"
                placeholder="Search for a show..."
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchForShow()}
              />
              <button onClick={searchForShow} disabled={addSearching}>
                {addSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div key={i} className="search-result-item">
                  <span>
                    {r.title} ({r.year})
                  </span>
                  <span className="placeholder">{r.seasonCount} seasons</span>
                </div>
              ))}
            </div>
            <button
              className="btn-close"
              onClick={() => setShowAddModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
