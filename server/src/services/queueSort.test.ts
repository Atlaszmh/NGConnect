import { describe, it, expect } from 'vitest';
import { parseEpisode } from './queueSort';
import { episodeSortOrder } from './queueSort';

const slot = (nzo_id: string, filename: string) => ({ nzo_id, filename });

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

describe('episodeSortOrder', () => {
  it('groups by show and orders episodes, holding a non-episode at its index', () => {
    // Canonical spec fixture: movie fixed at index 2; ShowB (min idx 0) before ShowA (min idx 1).
    const order = episodeSortOrder([
      slot('b2', 'ShowB.S01E02.1080p'),
      slot('a1', 'ShowA.S01E01.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
      slot('b1', 'ShowB.S01E01.1080p'),
      slot('a2', 'ShowA.S01E02.1080p'),
    ]);
    expect(order).toEqual(['b1', 'b2', 'mv', 'a1', 'a2']);
  });

  it('leaves one show split around a held movie (ordered but non-contiguous)', () => {
    const order = episodeSortOrder([
      slot('e3', 'ShowA.S01E03.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
      slot('e1', 'ShowA.S01E01.1080p'),
      slot('e2', 'ShowA.S01E02.1080p'),
    ]);
    expect(order).toEqual(['e1', 'mv', 'e2', 'e3']);
  });

  it('orders across seasons within a show', () => {
    const order = episodeSortOrder([
      slot('s2e1', 'ShowA.S02E01.1080p'),
      slot('s1e2', 'ShowA.S01E02.1080p'),
      slot('s1e1', 'ShowA.S01E01.1080p'),
    ]);
    expect(order).toEqual(['s1e1', 's1e2', 's2e1']);
  });

  it('is a no-op (same order) when already sorted', () => {
    const slots = [
      slot('a1', 'ShowA.S01E01.1080p'),
      slot('a2', 'ShowA.S01E02.1080p'),
      slot('mv', 'Some.Movie.2021.1080p'),
    ];
    expect(episodeSortOrder(slots)).toEqual(['a1', 'a2', 'mv']);
  });

  it('returns the same ids for an all-non-episode queue', () => {
    const slots = [slot('m1', 'Movie.One.2020.1080p'), slot('m2', 'Movie.Two.2021.1080p')];
    expect(episodeSortOrder(slots)).toEqual(['m1', 'm2']);
  });
});
