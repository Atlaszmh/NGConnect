export interface HistoryItem {
  id: string;                 // `${source}-${record.id}`
  source: 'radarr' | 'sonarr';
  kind: 'movie' | 'tv';
  title: string;
  event: 'imported' | 'failed';
  quality: string | null;
  sizeBytes: number | null;
  date: string;               // ISO; '' if absent
}

type Dict = Record<string, unknown>;

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function recordsOf(raw: unknown): Dict[] {
  if (!raw || typeof raw !== 'object') return [];
  const recs = (raw as Dict).records;
  return Array.isArray(recs) ? (recs as Dict[]) : [];
}

const EVENT_MAP: Record<string, 'imported' | 'failed'> = {
  downloadFolderImported: 'imported',
  downloadFailed: 'failed',
};

function normalizeRecord(rec: Dict, source: 'radarr' | 'sonarr'): HistoryItem | null {
  if (!rec || typeof rec !== 'object') return null;
  const eventType = typeof rec.eventType === 'string' ? rec.eventType : '';
  const event = EVENT_MAP[eventType];
  if (!event) return null; // skip grabbed / renames / deletions / etc.

  const sourceTitle = typeof rec.sourceTitle === 'string' ? rec.sourceTitle : '';
  const qualityObj = rec.quality as Dict | undefined;
  const qualityName = (qualityObj?.quality as Dict | undefined)?.name;
  const quality = typeof qualityName === 'string' ? qualityName : null;
  const data = rec.data && typeof rec.data === 'object' ? (rec.data as Dict) : {};
  const sizeBytes = toInt(data.size);
  const date = typeof rec.date === 'string' ? rec.date : '';
  const id = `${source}-${rec.id ?? ''}`;

  let kind: 'movie' | 'tv';
  let title: string;
  if (source === 'radarr') {
    kind = 'movie';
    const movie = rec.movie as Dict | undefined;
    if (movie && typeof movie.title === 'string') {
      title = typeof movie.year === 'number' ? `${movie.title} (${movie.year})` : movie.title;
    } else {
      title = sourceTitle;
    }
  } else {
    kind = 'tv';
    const series = rec.series as Dict | undefined;
    const ep = rec.episode as Dict | undefined;
    if (series && typeof series.title === 'string') {
      const s = ep?.seasonNumber;
      const e = ep?.episodeNumber;
      const se =
        typeof s === 'number' && typeof e === 'number'
          ? ` S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
          : '';
      title = `${series.title}${se}`;
    } else {
      title = sourceTitle;
    }
  }

  return { id, source, kind, title, event, quality, sizeBytes, date };
}

export function normalizeArrHistory(radarrRaw: unknown, sonarrRaw: unknown): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const rec of recordsOf(radarrRaw)) {
    const it = normalizeRecord(rec, 'radarr');
    if (it) items.push(it);
  }
  for (const rec of recordsOf(sonarrRaw)) {
    const it = normalizeRecord(rec, 'sonarr');
    if (it) items.push(it);
  }
  items.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va; // newest first; unparseable dates sink to the bottom
  });
  return items;
}
