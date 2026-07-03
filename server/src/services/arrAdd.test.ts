import { describe, it, expect } from 'vitest';
import { buildMovieAddPayload, buildSeriesAddPayload, movieLookupTerm } from './arrAdd';

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
  it('monitors exactly the selected season(s), unmonitors the rest (incl. season 0)', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1]) as Record<string, unknown>;
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
  it('monitors a multi-season selection', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1, 2]) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    expect(p.seasons.find((s) => s.seasonNumber === 0)?.monitored).toBe(false);
    expect(p.seasons.find((s) => s.seasonNumber === 1)?.monitored).toBe(true);
    expect(p.seasons.find((s) => s.seasonNumber === 2)?.monitored).toBe(true);
  });
  it('falls back to ALL seasons monitored when seasons is null, empty, or matches none', () => {
    const pNull = buildSeriesAddPayload(lookup(), 3, '/tv', null) as { seasons: { monitored: boolean }[] };
    expect(pNull.seasons.every((s) => s.monitored)).toBe(true);
    const pEmpty = buildSeriesAddPayload(lookup(), 3, '/tv', []) as { seasons: { monitored: boolean }[] };
    expect(pEmpty.seasons.every((s) => s.monitored)).toBe(true);
    const pNoMatch = buildSeriesAddPayload(lookup(), 3, '/tv', [9]) as { seasons: { monitored: boolean }[] };
    expect(pNoMatch.seasons.every((s) => s.monitored)).toBe(true);
  });
  it('includes languageProfileId only when provided', () => {
    const p = buildSeriesAddPayload(lookup(), 3, '/tv', [1], 2) as Record<string, unknown>;
    expect(p.languageProfileId).toBe(2);
  });
});

describe('search flag', () => {
  it('buildMovieAddPayload sets searchForMovie from the flag', () => {
    const off = buildMovieAddPayload({ tmdbId: 1 }, 3, '/movies') as Record<string, unknown>;
    expect(off.addOptions).toEqual({ searchForMovie: false }); // default unchanged
    const on = buildMovieAddPayload({ tmdbId: 1 }, 3, '/movies', true) as Record<string, unknown>;
    expect(on.addOptions).toEqual({ searchForMovie: true });
  });

  it('buildSeriesAddPayload sets searchForMissingEpisodes from the flag', () => {
    const lookup = { tvdbId: 1, seasons: [{ seasonNumber: 1, monitored: true }] };
    const off = buildSeriesAddPayload(lookup, 3, '/tv', null) as Record<string, unknown>;
    expect(off.addOptions).toEqual({ searchForMissingEpisodes: false }); // default unchanged
    const on = buildSeriesAddPayload(lookup, 3, '/tv', null, undefined, true) as Record<string, unknown>;
    expect(on.addOptions).toEqual({ searchForMissingEpisodes: true });
  });
});

describe('movieLookupTerm', () => {
  it('prefers tmdb when both ids are present', () => {
    expect(movieLookupTerm({ tmdbId: 27205, imdbId: 'tt1375666' })).toBe('tmdb:27205');
  });
  it('falls back to imdb when no tmdbId', () => {
    expect(movieLookupTerm({ imdbId: 'tt1375666' })).toBe('imdb:tt1375666');
  });
  it('throws when neither id is present', () => {
    expect(() => movieLookupTerm({})).toThrow();
  });
});
