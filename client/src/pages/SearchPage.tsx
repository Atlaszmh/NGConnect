import { useState } from 'react';
import { Search } from 'lucide-react';
import api from '../services/api';

interface NzbResult {
  guid: string;
  title: string;
  link: string;
  category: string;
  categoryId: number | null;
  sizeBytes: number;
  pubDate: string;
  grabs: number | null;
}

type SortKey = 'title' | 'category' | 'pubDate' | 'sizeBytes' | 'grabs';
type SortDir = 'asc' | 'desc';

const CATEGORIES: Record<string, string> = {
  '': 'All',
  '5000': 'TV',
  '5040': 'TV - HD',
  '5045': 'TV - UHD',
  '2000': 'Movies',
  '2040': 'Movies - HD',
  '2045': 'Movies - UHD',
  '3000': 'Audio',
};

const CATEGORY_LABELS: Record<number, string> = {
  2000: 'Movies', 2040: 'Movies - HD', 2045: 'Movies - UHD', 2030: 'Movies - SD',
  2050: 'Movies - BluRay', 2060: 'Movies - 3D',
  5000: 'TV', 5040: 'TV - HD', 5045: 'TV - UHD', 5030: 'TV - SD',
  3000: 'Audio',
};
function categoryLabel(r: NzbResult): string {
  if (r.categoryId != null && CATEGORY_LABELS[r.categoryId]) return CATEGORY_LABELS[r.categoryId];
  return r.category || (r.categoryId != null ? String(r.categoryId) : '--');
}

// Sort a COPY. Missing values (null grabs, size 0, empty/invalid date) always sink to the bottom.
function sortResults(rows: NzbResult[], key: SortKey | null, dir: SortDir): NzbResult[] {
  if (!key) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  const numeric = (r: NzbResult): number | null => {
    if (key === 'sizeBytes') return r.sizeBytes > 0 ? r.sizeBytes : null;
    if (key === 'grabs') return r.grabs;
    if (key === 'pubDate') {
      const t = Date.parse(r.pubDate);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  };
  const isText = key === 'title' || key === 'category';
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (isText) {
        const av = key === 'category' ? categoryLabel(a.r) : a.r.title;
        const bv = key === 'category' ? categoryLabel(b.r) : b.r.title;
        const cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' });
        return cmp !== 0 ? cmp * sign : a.i - b.i;
      }
      const av = numeric(a.r);
      const bv = numeric(b.r);
      // missing always last, regardless of dir
      if (av === null && bv === null) return a.i - b.i;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av !== bv ? (av - bv) * sign : a.i - b.i;
    })
    .map((x) => x.r);
}

// thousands-band routing: TV 5xxx -> sonarr, Movies 2xxx -> radarr, Audio 3xxx -> sab
type ArrTarget = 'sonarr' | 'radarr';
function bandTarget(catId: number | null | undefined): ArrTarget | 'sab' | null {
  if (catId == null) return null;
  const band = Math.floor(catId / 1000);
  if (band === 5) return 'sonarr';
  if (band === 2) return 'radarr';
  if (band === 3) return 'sab';
  return null;
}
// filter value from the dropdown is a category code string ('' = All)
function filterTarget(filterCat: string): ArrTarget | 'sab' | null {
  return bandTarget(filterCat ? parseInt(filterCat, 10) : null);
}
// Interpret a release/push response into a row outcome. Safe defaults:
// non-2xx -> error; any rejections/temporarilyRejected -> rejected; else grabbed.
function interpretPush(status: number, data: unknown): { state: GrabState; msg?: string } {
  if (status < 200 || status >= 300) {
    const m = (data as { error?: string; message?: string })?.error
      || (data as { message?: string })?.message || `HTTP ${status}`;
    return { state: 'error', msg: String(m) };
  }
  const d = (Array.isArray(data) ? data[0] : data) as {
    approved?: boolean; rejected?: boolean; temporarilyRejected?: boolean;
    rejections?: ({ reason?: string } | string)[];
  } | undefined;
  const rejections = d?.rejections;
  if ((Array.isArray(rejections) && rejections.length > 0) || d?.rejected || d?.temporarilyRejected) {
    const first = rejections?.[0];
    const reason = typeof first === 'string' ? first : first?.reason;
    return { state: 'rejected', msg: reason || 'Rejected by ' + (d?.rejected ? 'indexer' : 'the app') };
  }
  return { state: 'grabbed' };
}

type GrabState = 'idle' | 'sending' | 'grabbed' | 'rejected' | 'error';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<NzbResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [grab, setGrab] = useState<Record<string, { state: GrabState; msg?: string }>>({});
  const setRow = (guid: string, v: { state: GrabState; msg?: string }) =>
    setGrab((p) => ({ ...p, [guid]: v }));

  const clickSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // text asc first; numeric (size/grabs/age) desc first
      setSortDir(key === 'title' || key === 'category' ? 'asc' : 'desc');
    }
  };

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const res = await api.get('/nzbgeek/search', {
        params: { q: query, cat: category || undefined },
      });
      setResults(Array.isArray(res.data?.results) ? res.data.results : []);
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  const grabToArr = async (r: NzbResult, target: ArrTarget) => {
    setRow(r.guid, { state: 'sending' });
    try {
      const res = await api.post('/nzbgeek/send-to-arr', {
        title: r.title, nzbUrl: r.link, pubDate: r.pubDate, target,
      });
      setRow(r.guid, interpretPush(res.status, res.data));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number; data?: unknown } })?.response?.status;
      const data = (err as { response?: { data?: unknown } })?.response?.data;
      setRow(r.guid, interpretPush(status ?? 0, data));
    }
  };

  const grabToSab = async (r: NzbResult) => {
    setRow(r.guid, { state: 'sending' });
    try {
      await api.post('/nzbgeek/send-to-sab', { title: r.title, nzbUrl: r.link });
      setRow(r.guid, { state: 'grabbed', msg: 'Sent to SAB (no auto-import)' });
    } catch {
      setRow(r.guid, { state: 'error', msg: 'SAB error' });
    }
  };

  const formatSize = (sizeStr?: string) => {
    const bytes = parseInt(sizeStr || '0');
    if (!bytes) return '?';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1
      ? `${gb.toFixed(2)} GB`
      : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  };

  const formatAge = (dateStr?: string) => {
    if (!dateStr) return '?';
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return '?';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return '1 day';
    if (days < 60) return `${days} days`;
    const months = Math.floor(days / 30);
    return months < 24 ? `${months} mths` : `${Math.floor(days / 365)} yrs`;
  };

  const sorted = sortResults(results, sortKey, sortDir);

  return (
    <div className="page">
      <h2>Manual Search</h2>

      <div className="search-bar">
        <div className="search-input large">
          <Search size={20} />
          <input
            type="text"
            placeholder="Search NZBGeek..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {Object.entries(CATEGORIES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn-primary" onClick={doSearch} disabled={searching}>
          {searching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <div className="search-results-table">
          <table className="data-table">
            <thead>
              <tr>
                {([
                  ['title', 'Name'], ['category', 'Category'], ['pubDate', 'Age'],
                  ['sizeBytes', 'Size'], ['grabs', 'Grabs'],
                ] as [SortKey, string][]).map(([key, label]) => (
                  <th key={key} onClick={() => clickSort(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                    {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.guid}>
                  <td className="name-cell">{r.title}</td>
                  <td>{categoryLabel(r)}</td>
                  <td>{formatAge(r.pubDate)}</td>
                  <td>{formatSize(String(r.sizeBytes))}</td>
                  <td>{r.grabs != null ? r.grabs : '--'}</td>
                  <td>
                    {(() => {
                      const g = grab[r.guid]?.state ?? 'idle';
                      if (g === 'grabbed') return <span className="badge badge-success" title={grab[r.guid]?.msg}>Grabbed</span>;
                      // rejected uses badge-warning (amber) to read as "heads up, add it to the library",
                      // distinct from error's badge-danger (red). Both classes exist in index.css.
                      if (g === 'rejected') return <span className="badge badge-warning" title={grab[r.guid]?.msg}>Rejected: {grab[r.guid]?.msg}</span>;
                      if (g === 'sending') return <span className="placeholder">Sending…</span>;

                      // Resolve target: filter first, then result category band.
                      // Note: when resolved === 'sab' (Audio 3xxx), there is deliberately NO
                      // Sonarr/Radarr branch below — only the "→ SAB" escape hatch renders, which
                      // is the intended primary action for Audio.
                      const ft = filterTarget(category);
                      const rt = bandTarget(r.categoryId);
                      const resolved = ft ?? rt;

                      return (
                        <div className="grab-actions" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {resolved === 'sonarr' && <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'sonarr')}>Sonarr</button>}
                          {resolved === 'radarr' && <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'radarr')}>Radarr</button>}
                          {resolved == null && (
                            <>
                              <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'sonarr')}>Sonarr</button>
                              <button className="btn-sm btn-primary" onClick={() => grabToArr(r, 'radarr')}>Radarr</button>
                            </>
                          )}
                          {/* SAB escape hatch — always available; won't auto-import */}
                          <button className="btn-sm" title="Send straight to SABnzbd (won't auto-import into Plex)" onClick={() => grabToSab(r)}>→ SAB</button>
                          {g === 'error' && <span className="badge badge-danger" title={grab[r.guid]?.msg}>Error</span>}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!searching && results.length === 0 && query && (
        <p className="placeholder">No results found for "{query}"</p>
      )}
    </div>
  );
}
