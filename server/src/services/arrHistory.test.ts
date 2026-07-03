import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
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

describe('normalizeArrHistory — failure reason', () => {
  it('extracts reason + size from the REAL captured Sonarr failed record', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/sonarr-history-failed.json'), 'utf-8')
    );
    const [item] = normalizeArrHistory(null, raw); // the record is a Sonarr record
    expect(item).toMatchObject({
      source: 'sonarr',
      kind: 'tv',
      event: 'failed',
      reason: 'Aborted, cannot be completed - https://sabnzbd.org/not-complete',
      sizeBytes: 0, // data.size "0"
      // raw capture has no series/episode include object → title falls back to sourceTitle
      title: 'Widows.Bay.S01.1080p.WEBRip.10bit.DDP5.1.x265-NeoNoir',
    });
  });

  it('reason is null for imported rows', () => {
    // radarrImported() / sonarrImported() are the existing helpers in this file
    const items = normalizeArrHistory(wrap([radarrImported()]), wrap([sonarrImported()]));
    expect(items.every((i) => i.reason === null)).toBe(true);
  });

  it('reason is null for a failed record with no data.message', () => {
    const rec = { id: 3, eventType: 'downloadFailed', sourceTitle: 'X-GRP', date: '2026-07-01T00:00:00Z', data: { size: '123' } };
    const [item] = normalizeArrHistory(wrap([rec]), null);
    expect(item.event).toBe('failed');
    expect(item.reason).toBeNull();
  });

  it('extracts reason from a synthetic failed record with data.message', () => {
    const rec = { id: 4, eventType: 'downloadFailed', sourceTitle: 'Y-GRP', date: '2026-07-01T00:00:00Z', data: { message: 'boom', size: '9' } };
    const [item] = normalizeArrHistory(wrap([rec]), null);
    expect(item.reason).toBe('boom');
  });
});
