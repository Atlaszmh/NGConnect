import { useState, useEffect, useRef } from 'react';
import { Bell, Check, Trash2, X } from 'lucide-react';
import api from '../services/api';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchCount, 10000);
    return () => clearInterval(interval);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchNotifications = async () => {
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data.notifications);
      setUnreadCount(res.data.unreadCount);
    } catch {
      // Silent fail
    }
  };

  const fetchCount = async () => {
    try {
      const res = await api.get('/notifications/count');
      setUnreadCount(res.data.unreadCount);
    } catch {
      // Silent fail
    }
  };

  const markAllRead = async () => {
    await api.post('/notifications/read-all');
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const clearAll = async () => {
    await api.delete('/notifications');
    setNotifications([]);
    setUnreadCount(0);
  };

  const toggle = () => {
    if (!open) fetchNotifications();
    setOpen(!open);
  };

  const typeColors: Record<string, string> = {
    success: 'var(--color-success)',
    error: 'var(--color-danger)',
    warning: 'var(--color-warning)',
    info: 'var(--color-accent)',
  };

  const timeAgo = (iso: string) => {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return (
    <div className="notification-bell" ref={ref}>
      <button className="btn-icon" onClick={toggle} title="Notifications">
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-drawer">
          <div className="notification-header">
            <span>Notifications</span>
            <div className="notification-actions">
              {unreadCount > 0 && (
                <button className="btn-icon-sm" onClick={markAllRead} title="Mark all read">
                  <Check size={14} />
                </button>
              )}
              {notifications.length > 0 && (
                <button className="btn-icon-sm" onClick={clearAll} title="Clear all">
                  <Trash2 size={14} />
                </button>
              )}
              <button className="btn-icon-sm" onClick={() => setOpen(false)}>
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="notification-list">
            {notifications.length === 0 ? (
              <p className="notification-empty">No notifications</p>
            ) : (
              notifications.slice(0, 20).map((n) => (
                <div
                  key={n.id}
                  className={`notification-item ${n.read ? 'read' : 'unread'}`}
                >
                  <span
                    className="notification-dot"
                    style={{ backgroundColor: typeColors[n.type] || typeColors.info }}
                  />
                  <div className="notification-content">
                    <div className="notification-title">{n.title}</div>
                    <div className="notification-message">{n.message}</div>
                    <div className="notification-time">{timeAgo(n.timestamp)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
