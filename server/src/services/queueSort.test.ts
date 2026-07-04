import { describe, it, expect } from 'vitest';
import { parseEpisode } from './queueSort';

describe('parseEpisode', () => {
  it('parses standard S01E05', () => {
    expect(parseEpisode('The.Mandalorian.S02E05.1080p.WEB.H264-GRP')).toEqual({
      show: 'the mandalorian', season: 2, episode: 5,
    });
  });
  it('is case-insensitive and handles space/underscore separators', () => {
    expect(parseEpisode('some show s1e5 720p')).toEqual({ show: 'some show', season: 1, episode: 5 });
    expect(parseEpisode('Some_Show_S01E09_x265')).toEqual({ show: 'some show', season: 1, episode: 9 });
  });
  it('uses the FIRST episode of a multi-episode file', () => {
    expect(parseEpisode('Show.Name.S01E01E02.1080p')).toMatchObject({ season: 1, episode: 1 });
    expect(parseEpisode('Show.Name.S01E01-E02.1080p')).toMatchObject({ season: 1, episode: 1 });
  });
  it('finds SxxEyy even when the show name contains digits', () => {
    expect(parseEpisode('The.100.S03E05.1080p')).toEqual({ show: 'the 100', season: 3, episode: 5 });
  });
  it('returns null for a season pack (no E)', () => {
    expect(parseEpisode('The.Show.S01.1080p.WEBRip')).toBeNull();
  });
  it('returns null for a separator between the S and E blocks (S01.E01)', () => {
    expect(parseEpisode('Show.Name.S01.E01.1080p')).toBeNull();
  });
  it('returns null for movies and date-based / unparseable names', () => {
    expect(parseEpisode('Some.Movie.2021.1080p.BluRay.x264')).toBeNull();
    expect(parseEpisode('Daily.Show.2024.01.15.1080p')).toBeNull();
    expect(parseEpisode('')).toBeNull();
  });
});
