import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import ServiceStatus from '../components/ServiceStatus';
import api from '../services/api';

interface ServiceInfo {
  status: 'online' | 'offline' | 'error' | 'checking';
  url: string;
}

interface QueueItem {
  title: string;
  status: string;
  sizeleft: string;
  size: string;
  timeleft: string;
  percentage: number;
}

interface CalendarEpisode {
  seriesTitle?: string;
  series?: { title: string };
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc: string;
  hasFile: boolean;
}

export default function DashboardPage() {
  const [services, setServices] = useState<Record<string, ServiceInfo>>({
    sonarr: { status: 'checking', url: '' },
    radarr: { status: 'checking', url: '' },
    sabnzbd: { status: 'checking', url: '' },
  });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [calendar, setCalendar] = useState<CalendarEpisode[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = async () => {
    setRefreshing(true);

    // Fetch service statuses
    try {
      const res = await api.get('/system/status');
      setServices(res.data.services);
    } catch {
      setServices({
        sonarr: { status: 'offline', url: '' },
        radarr: { status: 'offline', url: '' },
        sabnzbd: { status: 'offline', url: '' },
      });
    }

    // Fetch SABnzbd queue
    try {
      const res = await api.get('/sabnzbd/api', { params: { mode: 'queue' } });
      const slots = res.data?.queue?.slots || [];
      setQueue(
        slots.map((s: Record<string, string>) => ({
          title: s.filename,
          status: s.status,
          sizeleft: s.sizeleft,
          size: s.size,
          timeleft: s.timeleft,
          percentage: parseFloat(s.percentage) || 0,
        }))
      );
    } catch {
      setQueue([]);
    }

    // Fetch Sonarr calendar (next 7 days)
    try {
      const start = new Date().toISOString().split('T')[0];
      const end = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const res = await api.get('/sonarr/calendar', {
        params: { start, end, includeSeries: true },
      });
      setCalendar(Array.isArray(res.data) ? res.data : []);
    } catch {
      setCalendar([]);
    }

    setRefreshing(false);
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <h2>System Overview</h2>
        <button
          className="btn-icon"
          onClick={fetchAll}
          disabled={refreshing}
          title="Refresh"
        >
          <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
        </button>
      </div>

      <div className="card-grid">
        {/* Service Status */}
        <div className="card">
          <h3>Service Status</h3>
          {Object.entries(services).map(([name, info]) => (
            <ServiceStatus
              key={name}
              name={name.charAt(0).toUpperCase() + name.slice(1)}
              status={info.status}
              url={info.url}
            />
          ))}
        </div>

        {/* Active Downloads */}
        <div className="card">
          <h3>Active Downloads</h3>
          {queue.length === 0 ? (
            <p className="placeholder">No active downloads</p>
          ) : (
            <div className="download-list">
              {queue.slice(0, 5).map((item, i) => (
                <div key={i} className="download-item">
                  <div className="download-title">{item.title}</div>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${item.percentage}%` }}
                    />
                  </div>
                  <div className="download-meta">
                    <span>{item.percentage.toFixed(1)}%</span>
                    <span>{item.timeleft || 'Calculating...'}</span>
                  </div>
                </div>
              ))}
              {queue.length > 5 && (
                <p className="placeholder">+{queue.length - 5} more in queue</p>
              )}
            </div>
          )}
        </div>

        {/* Upcoming Episodes */}
        <div className="card">
          <h3>Upcoming Episodes</h3>
          {calendar.length === 0 ? (
            <p className="placeholder">No upcoming episodes this week</p>
          ) : (
            <div className="episode-list">
              {calendar.slice(0, 8).map((ep, i) => {
                const showName = ep.series?.title || ep.seriesTitle || 'Unknown';
                const airDate = new Date(ep.airDateUtc);
                return (
                  <div key={i} className="episode-item">
                    <div className="episode-info">
                      <span className="episode-show">{showName}</span>
                      <span className="episode-detail">
                        S{String(ep.seasonNumber).padStart(2, '0')}E
                        {String(ep.episodeNumber).padStart(2, '0')} - {ep.title}
                      </span>
                    </div>
                    <div className="episode-meta">
                      <span className="episode-date">
                        {airDate.toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      {ep.hasFile && <span className="badge badge-success">Downloaded</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* VPN Status */}
        <div className="card">
          <h3>VPN Status</h3>
          <p className="placeholder">VPN monitoring will be configured in Settings</p>
        </div>
      </div>
    </div>
  );
}
