import { useEffect, useState, useCallback } from 'react';
import { Pause, Play, Trash2, RefreshCw, AlertCircle, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import api from '../services/api';

interface QueueSlot {
  nzo_id: string;
  filename: string;
  status: string;
  mb: string;
  mbleft: string;
  percentage: string;
  timeleft: string;
  cat: string;
  priority: string;
  size: string;
  sizeleft: string;
}

interface HistoryItem {
  id: string;
  source: 'radarr' | 'sonarr';
  kind: 'movie' | 'tv';
  title: string;
  event: 'imported' | 'failed';
  quality: string | null;
  sizeBytes: number | null;
  date: string;
}

interface QueueData {
  paused: boolean;
  speed: string;
  sizeleft: string;
  timeleft: string;
  diskspace1: string;
  slots: QueueSlot[];
}

function formatDownloaded(totalMb: string, leftMb: string): string {
  const total = parseFloat(totalMb) || 0;
  const left = parseFloat(leftMb) || 0;
  const downloaded = total - left;
  if (downloaded >= 1024) return `${(downloaded / 1024).toFixed(1)} GB`;
  if (downloaded >= 1) return `${downloaded.toFixed(0)} MB`;
  return `${(downloaded * 1024).toFixed(0)} KB`;
}

function formatSizeBytes(bytes: number | null): string {
  if (!bytes) return '--';
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
function formatAge(dateStr: string): string {
  if (!dateStr) return '--';
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return '--';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day';
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} mths` : `${Math.floor(days / 365)} yrs`;
}

function SortableQueueItem({
  slot,
  onDelete,
}: {
  slot: QueueSlot;
  onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.nzo_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="download-item">
      <div className="download-header">
        <div className="download-title-row">
          <button
            className="btn-icon-sm drag-handle"
            {...attributes}
            {...listeners}
            title="Drag to reorder"
          >
            <GripVertical size={14} />
          </button>
          <span className="download-title">{slot.filename}</span>
        </div>
        <div className="download-actions">
          <span className="badge">{slot.cat}</span>
          <button
            className="btn-icon-sm"
            onClick={() => onDelete(slot.nzo_id)}
            title="Remove"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{ width: `${parseFloat(slot.percentage)}%` }}
        />
      </div>
      <div className="download-meta">
        <span>
          {formatDownloaded(slot.mb, slot.mbleft)} / {slot.size}
        </span>
        <span>{parseFloat(slot.percentage).toFixed(1)}%</span>
        <span>{slot.timeleft || 'Calculating...'}</span>
      </div>
    </div>
  );
}

export default function DownloadsPage() {
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'queue' | 'history'>('queue');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fetchQueue = useCallback(async () => {
    try {
      const res = await api.get('/sabnzbd/api', { params: { mode: 'queue' } });
      setQueue(res.data?.queue || null);
    } catch {
      setQueue(null);
    }
    setLoading(false);
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await api.get('/system/history');
      setHistory(Array.isArray(res.data?.items) ? res.data.items : []);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    fetchHistory();
    const interval = setInterval(fetchQueue, 5000);
    return () => clearInterval(interval);
  }, [fetchQueue, fetchHistory]);

  const togglePause = async () => {
    const mode = queue?.paused ? 'resume' : 'pause';
    await api.get('/sabnzbd/api', { params: { mode } });
    fetchQueue();
  };

  const deleteItem = async (nzoId: string) => {
    await api.get('/sabnzbd/api', {
      params: { mode: 'queue', name: 'delete', value: nzoId },
    });
    fetchQueue();
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !queue?.slots) return;

    const oldIndex = queue.slots.findIndex((s) => s.nzo_id === active.id);
    const newIndex = queue.slots.findIndex((s) => s.nzo_id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Optimistically reorder locally
    setQueue((prev) =>
      prev ? { ...prev, slots: arrayMove(prev.slots, oldIndex, newIndex) } : prev,
    );

    // Tell SABnzbd to move the item to the new position
    await api.get('/sabnzbd/api', {
      params: { mode: 'switch', value: active.id, value2: newIndex },
    });
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>Downloads</h2>
        <div className="header-actions">
          {queue && (
            <button onClick={togglePause}>
              {queue.paused ? <Play size={16} /> : <Pause size={16} />}
              {queue.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            className="btn-icon"
            onClick={() => {
              fetchQueue();
              fetchHistory();
            }}
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Speed & Stats Bar */}
      {queue && (
        <div className="stats-bar">
          <div className="stat">
            <span className="stat-label">Speed</span>
            <span className="stat-value">{queue.speed}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Remaining</span>
            <span className="stat-value">{queue.sizeleft || '0 B'}</span>
          </div>
          <div className="stat">
            <span className="stat-label">ETA</span>
            <span className="stat-value">{queue.timeleft || '--'}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Disk Space</span>
            <span className="stat-value">{queue.diskspace1 || '?'} GB</span>
          </div>
          {queue.paused && (
            <div className="stat">
              <span className="badge badge-warning">PAUSED</span>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="tab-bar">
        <button
          className={`tab ${tab === 'queue' ? 'active' : ''}`}
          onClick={() => setTab('queue')}
        >
          Queue ({queue?.slots?.length || 0})
        </button>
        <button
          className={`tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setTab('history');
            fetchHistory();
          }}
        >
          History ({history.length})
        </button>
      </div>

      {loading ? (
        <p className="placeholder">Loading from SABnzbd...</p>
      ) : tab === 'queue' ? (
        <div className="download-list">
          {!queue?.slots?.length ? (
            <p className="placeholder">Download queue is empty</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={queue.slots.map((s) => s.nzo_id)}
                strategy={verticalListSortingStrategy}
              >
                {queue.slots.map((slot) => (
                  <SortableQueueItem
                    key={slot.nzo_id}
                    slot={slot}
                    onDelete={deleteItem}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      ) : (
        <div className="history-list">
          {history.length === 0 ? (
            <p className="placeholder">No download history</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Event</th>
                  <th>Quality</th>
                  <th>Size</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td className="name-cell">{item.title}</td>
                    <td>
                      <span className="badge">{item.kind === 'tv' ? 'TV' : 'Movie'}</span>
                    </td>
                    <td>
                      {item.event === 'imported' ? (
                        <span className="badge badge-success">Imported</span>
                      ) : (
                        <span className="badge badge-danger">
                          <AlertCircle size={12} /> Failed
                        </span>
                      )}
                    </td>
                    <td>{item.quality || '--'}</td>
                    <td>{formatSizeBytes(item.sizeBytes)}</td>
                    <td>{formatAge(item.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
