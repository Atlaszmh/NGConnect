import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  Download,
  Shield,
  Server,
} from 'lucide-react';
import api from '../services/api';

interface ServiceInfo {
  status: 'online' | 'offline' | 'error' | 'checking';
}

interface ActiveSlot {
  filename: string;
  percentage: string;
}

interface QueueSummary {
  speed: string;
  sizeleft: string;
  timeleft: string;
  paused: boolean;
  activeCount: number;
  currentFile: string;
  currentPct: number;
}

interface VpnInfo {
  connected: boolean;
  ip: string;
  country?: string;
}

export default function StatusBar() {
  const [services, setServices] = useState<Record<string, ServiceInfo>>({});
  const [queue, setQueue] = useState<QueueSummary | null>(null);
  const [vpn, setVpn] = useState<VpnInfo | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, queueRes, vpnRes] = await Promise.allSettled([
        api.get('/system/status'),
        api.get('/sabnzbd/api', { params: { mode: 'queue' } }),
        api.get('/system/vpn'),
      ]);

      if (statusRes.status === 'fulfilled') {
        setServices(statusRes.value.data.services);
      }

      if (queueRes.status === 'fulfilled') {
        const q = queueRes.value.data?.queue;
        if (q) {
          const slots: ActiveSlot[] = q.slots || [];
          const first = slots[0];
          setQueue({
            speed: q.speed || '0 B/s',
            sizeleft: q.sizeleft || '0 B',
            timeleft: q.timeleft || '',
            paused: q.paused ?? false,
            activeCount: slots.length,
            currentFile: first?.filename || '',
            currentPct: first ? parseFloat(first.percentage) || 0 : 0,
          });
        }
      }

      if (vpnRes.status === 'fulfilled') {
        setVpn(vpnRes.value.data);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const onlineCount = Object.values(services).filter(
    (s) => s.status === 'online'
  ).length;
  const totalCount = Object.keys(services).length;

  return (
    <div className="global-status-bar">
      {/* Services */}
      <div className="status-item">
        <Server size={14} />
        <span className="status-label">Services</span>
        <span
          className={`status-value ${
            onlineCount === totalCount
              ? 'text-success'
              : onlineCount === 0
              ? 'text-danger'
              : 'text-warning'
          }`}
        >
          {totalCount > 0 ? `${onlineCount}/${totalCount}` : '--'}
        </span>
      </div>

      {/* Downloads */}
      <div className="status-item status-item-downloads">
        <Download size={14} />
        <span className="status-label">Downloads</span>
        {queue ? (
          queue.activeCount > 0 ? (
            <>
              {!queue.paused && (
                <>
                  <Activity size={12} className="text-success" />
                  <span className="status-value">{queue.speed}</span>
                </>
              )}
              {queue.paused && (
                <span className="status-badge status-badge-warning">PAUSED</span>
              )}
              <span className="status-sep">|</span>
              <span className="status-filename" title={queue.currentFile}>
                {queue.currentFile}
              </span>
              <span className="status-detail">
                {queue.currentPct.toFixed(0)}%
              </span>
              {queue.activeCount > 1 && (
                <span className="status-detail">
                  +{queue.activeCount - 1} more
                </span>
              )}
              {queue.timeleft && !queue.paused && (
                <>
                  <span className="status-sep">|</span>
                  <span className="status-detail">ETA {queue.timeleft}</span>
                </>
              )}
            </>
          ) : (
            <span className="status-value text-muted">Idle</span>
          )
        ) : (
          <span className="status-value text-muted">--</span>
        )}
      </div>

      {/* VPN */}
      <div className="status-item">
        <div
          className={`status-dot-indicator ${
            vpn ? (vpn.connected ? 'dot-success' : 'dot-danger') : 'dot-muted'
          }`}
        />
        <Shield size={14} />
        <span className="status-label">VPN</span>
        {vpn ? (
          <span
            className={`status-value ${
              vpn.connected ? 'text-success' : 'text-danger'
            }`}
          >
            {vpn.connected
              ? vpn.country || vpn.ip || 'Connected'
              : 'Disconnected'}
          </span>
        ) : (
          <span className="status-value text-muted">--</span>
        )}
      </div>
    </div>
  );
}
