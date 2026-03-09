import { useState } from 'react';
import { Search, Send } from 'lucide-react';
import api from '../services/api';

interface NzbResult {
  title: string;
  guid: string;
  link: string;
  size: string;
  pubDate: string;
  category: string;
  attr?: { name: string; value: string }[];
  enclosure?: { '@attributes'?: { length?: string } };
}

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

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<NzbResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const res = await api.get('/nzbgeek/search', {
        params: { q: query, cat: category || undefined },
      });
      // Newznab JSON response structure
      const items = res.data?.channel?.item || res.data?.item || [];
      setResults(Array.isArray(items) ? items : [items]);
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  const sendToSab = async (result: NzbResult) => {
    setSending(result.guid);
    try {
      await api.post('/nzbgeek/send-to-sab', {
        title: result.title,
        nzbUrl: result.link,
      });
      setSent((prev) => new Set(prev).add(result.guid));
    } catch {
      // Error sending
    }
    setSending(null);
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
    const days = Math.floor(
      (Date.now() - new Date(dateStr).getTime()) / 86400000
    );
    if (days === 0) return 'Today';
    if (days === 1) return '1 day';
    return `${days} days`;
  };

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
                <th>Name</th>
                <th>Category</th>
                <th>Size</th>
                <th>Age</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const size =
                  r.enclosure?.['@attributes']?.length || r.size || '0';
                return (
                  <tr key={r.guid}>
                    <td className="name-cell">{r.title}</td>
                    <td>{r.category || '--'}</td>
                    <td>{formatSize(size)}</td>
                    <td>{formatAge(r.pubDate)}</td>
                    <td>
                      {sent.has(r.guid) ? (
                        <span className="badge badge-success">Sent</span>
                      ) : (
                        <button
                          className="btn-sm btn-primary"
                          onClick={() => sendToSab(r)}
                          disabled={sending === r.guid}
                        >
                          {sending === r.guid ? (
                            'Sending...'
                          ) : (
                            <>
                              <Send size={12} /> SABnzbd
                            </>
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
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
