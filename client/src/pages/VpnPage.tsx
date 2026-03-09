import { useEffect, useState, useCallback } from 'react';
import { Shield, ShieldOff, RefreshCw, Globe, Pause, Play } from 'lucide-react';
import api from '../services/api';

interface VpnState {
  connected: boolean;
  ip: string;
  country?: string;
  lastCheck: string;
  lastChange?: string;
  downloadsPaused: boolean;
}

interface KillSwitchConfig {
  enabled: boolean;
  autoResume: boolean;
  pollIntervalMs: number;
  gracePeriodMs: number;
}

export default function VpnPage() {
  const [vpn, setVpn] = useState<VpnState | null>(null);
  const [ks, setKs] = useState<KillSwitchConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [vpnRes, ksRes] = await Promise.all([
        api.get('/system/vpn'),
        api.get('/system/vpn/killswitch'),
      ]);
      setVpn(vpnRes.data);
      setKs(ksRes.data);
    } catch {
      setVpn({ connected: false, ip: 'Unknown', lastCheck: '', downloadsPaused: false });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const toggleKillSwitch = async (field: string, value: boolean) => {
    try {
      const res = await api.put('/system/vpn/killswitch', { [field]: value });
      setKs(res.data);
    } catch {
      // Failed to update
    }
  };

  const timeSince = (iso?: string) => {
    if (!iso) return 'Never';
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>VPN Status</h2>
        <button className="btn-icon" onClick={fetchAll} title="Refresh">
          <RefreshCw size={16} />
        </button>
      </div>

      {loading ? (
        <p className="placeholder">Checking VPN status...</p>
      ) : (
        <div className="card-grid">
          {/* Connection Status */}
          <div className="card">
            <div className="vpn-status-display">
              {vpn?.connected ? (
                <>
                  <Shield size={48} className="vpn-icon connected" />
                  <h3 className="vpn-state connected">VPN Connected</h3>
                </>
              ) : (
                <>
                  <ShieldOff size={48} className="vpn-icon disconnected" />
                  <h3 className="vpn-state disconnected">VPN Disconnected</h3>
                </>
              )}
              {vpn?.downloadsPaused && (
                <span className="badge badge-warning">
                  <Pause size={12} /> Downloads Paused
                </span>
              )}
            </div>
          </div>

          {/* Connection Details */}
          <div className="card">
            <h3>Connection Details</h3>
            <div className="detail-list">
              <div className="detail-row">
                <Globe size={16} />
                <span className="detail-label">Public IP</span>
                <span className="detail-value">{vpn?.ip || 'Unknown'}</span>
              </div>
              {vpn?.country && (
                <div className="detail-row">
                  <span className="detail-label">Location</span>
                  <span className="detail-value">{vpn.country}</span>
                </div>
              )}
              <div className="detail-row">
                <span className="detail-label">Last Check</span>
                <span className="detail-value">{timeSince(vpn?.lastCheck)}</span>
              </div>
              {vpn?.lastChange && (
                <div className="detail-row">
                  <span className="detail-label">Last Change</span>
                  <span className="detail-value">{timeSince(vpn.lastChange)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Kill Switch Controls */}
          <div className="card">
            <h3>Download Protection (Kill Switch)</h3>
            {ks && (
              <div className="toggle-list">
                <div className="toggle-row">
                  <div>
                    <div className="toggle-label">Kill Switch</div>
                    <div className="toggle-desc">
                      Auto-pause SABnzbd downloads when VPN disconnects
                    </div>
                  </div>
                  <button
                    className={`toggle-btn ${ks.enabled ? 'active' : ''}`}
                    onClick={() => toggleKillSwitch('enabled', !ks.enabled)}
                  >
                    {ks.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="toggle-row">
                  <div>
                    <div className="toggle-label">Auto-Resume</div>
                    <div className="toggle-desc">
                      Automatically resume downloads when VPN reconnects
                    </div>
                  </div>
                  <button
                    className={`toggle-btn ${ks.autoResume ? 'active' : ''}`}
                    onClick={() => toggleKillSwitch('autoResume', !ks.autoResume)}
                  >
                    {ks.autoResume ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="toggle-row">
                  <div>
                    <div className="toggle-label">Check Interval</div>
                    <div className="toggle-desc">
                      {(ks.pollIntervalMs / 1000).toFixed(0)}s between VPN checks
                    </div>
                  </div>
                </div>
                <div className="toggle-row">
                  <div>
                    <div className="toggle-label">Grace Period</div>
                    <div className="toggle-desc">
                      {(ks.gracePeriodMs / 1000).toFixed(0)}s before pausing
                      (avoids false positives)
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Download Status */}
          <div className="card">
            <h3>Download Status</h3>
            <div className="vpn-status-display">
              {vpn?.downloadsPaused ? (
                <>
                  <Pause size={32} className="vpn-icon disconnected" />
                  <p className="placeholder">
                    Downloads are paused due to VPN disconnect.
                    {ks?.autoResume
                      ? ' They will auto-resume when VPN reconnects.'
                      : ' Manually resume in the Downloads page.'}
                  </p>
                </>
              ) : (
                <>
                  <Play size={32} className="vpn-icon connected" />
                  <p className="placeholder">Downloads are running normally.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
