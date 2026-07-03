import { describe, it, expect } from 'vitest';
import { normalizeArrHistory } from './arrHistory';

// Minimal records in the documented Radarr/Sonarr /history shape.
function radarrImported(over = {}) {
  return {
    id: 10, movieId: 5, eventType: 'downloadFolderImported',
    sourceTitle: 'The.Matrix.1999.1080p.BluRay.x264-GRP',
    quality: { quality: { name: 'Bluray-1080p' } },
    date: '2026-07-02T10:00:00Z',
    data: { size: '9387696000' },
    movie: { title: 'The Matrix', year: 1999 },
    ...over,
  };
}
function sonarrImported(over = {}) {
  return {
    id: 20, seriesId: 7, episodeId: 99, eventType: 'downloadFolderImported',
    sourceTitle: 'The.Mandalorian.S01E05.1080p.WEB.x264-GRP',
    quality: { quality: { name: 'WEBDL-1080p' } },
    date: '2026-07-03T12:00:00Z',
    data: { size: '2100000000' },
    series: { title: 'The Mandalorian' },
    episode: { seasonNumber: 1, episodeNumber: 5, title: 'Chapter 5' },
    ...over,
  };
}
const wrap = (records: unknown[]) => ({ page: 1, pageSize: 50, totalRecords: records.length, records });

describe('normalizeArrHistory', () => {
  it('maps a Radarr imported movie', () => {
    const [it0] = normalizeArrHistory(wrap([radarrImported()]), null);
    expect(it0).toMatchObject({
      id: 'radarr-10', source: 'radarr', kind: 'movie',
      title: 'The Matrix (1999)', event: 'imported',
      quality: 'Bluray-1080p', sizeBytes: 9387696000, date: '2026-07-02T10:00:00Z',
    });
  });

  it('maps a Sonarr imported episode with SxxExx', () => {
    const [it0] = normalizeArrHistory(null, wrap([sonarrImported()]));
    expect(it0).toMatchObject({
      id: 'sonarr-20', source: 'sonarr', kind: 'tv',
      title: 'The Mandalorian S01E05', event: 'imported', quality: 'WEBDL-1080p',
    });
  });

  it('maps downloadFailed → failed', () => {
    const [it0] = normalizeArrHistory(wrap([radarrImported({ eventType: 'downloadFailed' })]), null);
    expect(it0.event).toBe('failed');
  });

  it('filters out non-import/fail events (grabbed, renames)', () => {
    const items = normalizeArrHistory(
      wrap([radarrImported({ eventType: 'grabbed' }), radarrImported({ eventType: 'movieFileRenamed' })]),
      null
    );
    expect(items).toHaveLength(0);
  });

  it('falls back to sourceTitle and null quality/size on missing fields', () => {
    const rec = { id: 1, eventType: 'downloadFolderImported', sourceTitle: 'Some.Release-GRP', date: '2026-07-01T00:00:00Z' };
    const [it0] = normalizeArrHistory(wrap([rec]), null);
    expect(it0).toMatchObject({ title: 'Some.Release-GRP', quality: null, sizeBytes: null });
  });

  it('merges both arrs sorted newest-first', () => {
    const items = normalizeArrHistory(wrap([radarrImported()]), wrap([sonarrImported()]));
    expect(items.map((i) => i.source)).toEqual(['sonarr', 'radarr']); // sonarr date is newer
  });

  it('returns [] for malformed input', () => {
    expect(normalizeArrHistory(null, null)).toEqual([]);
    expect(normalizeArrHistory({}, 'nope')).toEqual([]);
    expect(normalizeArrHistory({ records: 'x' }, undefined)).toEqual([]);
  });
});
