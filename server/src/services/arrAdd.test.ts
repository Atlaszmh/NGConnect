import { describe, it, expect } from 'vitest';
import { buildMovieAddPayload, buildSeriesAddPayload } from './arrAdd';

describe('buildMovieAddPayload', () => {
  it('enriches the lookup object; our fields override', () => {
    const lookup = { tmdbId: 27205, title: 'Inception', monitored: false, addOptions: { searchForMovie: true } };
    const p = buildMovieAddPayload(lookup, 3, '/movies') as Record<string, unknown>;
    expect(p.tmdbId).toBe(27205);
    expect(p.qualityProfileId).toBe(3);
    expect(p.rootFolderPath).toBe('/movies');
    expect(p.monitored).toBe(true); // overrides lookup's false
    expect(p.minimumAvailability).toBe('released');
    expect(p.addOptions).toEqual({ searchForMovie: false }); // overrides lookup
  });
});

describe('buildSeriesAddPayload', () => {
  const lookup = () => ({
    tvdbId: 361753, title: 'The Mandalorian',
    seasons: [{ seasonNumber: 0, monitored: true }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }],
  });
  it('monitors only the grabbed season, unmonitors the rest', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1) as Record<string, unknown>;
    expect(p.qualityProfileId).toBe(3);
    expect(p.monitored).toBe(true);
    expect(p.addOptions).toEqual({ searchForMissingEpisodes: false });
    expect(p.seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
    ]);
    expect('languageProfileId' in p).toBe(false);
  });
  it('season pack (season known) still monitors that season', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    expect(p.seasons.find((s) => s.seasonNumber === 1)?.monitored).toBe(true);
  });
  it('falls back to ALL seasons monitored when season is null or no match', () => {
    const pNull = buildSeriesAddPayload(lookup(), 3, '/tv', null) as { seasons: { monitored: boolean }[] };
    expect(pNull.seasons.every((s) => s.monitored)).toBe(true);
    const pNoMatch = buildSeriesAddPayload(lookup(), 3, '/tv', 9) as { seasons: { monitored: boolean }[] };
    expect(pNoMatch.seasons.every((s) => s.monitored)).toBe(true);
  });
  it('includes languageProfileId only when provided', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', 1, 2) as Record<string, unknown>;
    expect(p.languageProfileId).toBe(2);
  });
});
