import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseNewznabResults, formatImdbId } from './newznab';

// Minimal Newznab item in the REAL shape: attrs nested under @attributes.
function item(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Show.Name.S01E01.1080p.WEB.x264-GRP',
    guid: 'abc123',
    link: 'https://api.nzbgeek.info/api?t=get&id=abc123&apikey=REDACTED',
    enclosure: { '@attributes': { url: 'https://x/nzb', length: '1500000000', type: 'application/x-nzb' } },
    attr: [
      { '@attributes': { name: 'category', value: '5000' } },
      { '@attributes': { name: 'category', value: '5040' } },
      { '@attributes': { name: 'size', value: '1500000000' } },
      { '@attributes': { name: 'grabs', value: '42' } },
      { '@attributes': { name: 'usenetdate', value: 'Mon, 29 Jun 2026 15:22:00 +0000' } },
    ],
    ...overrides,
  };
}

describe('parseNewznabResults — core shape', () => {
  it('reads @attributes-nested attrs (grabs/size), most-specific categoryId, usenetdate', () => {
    const [r] = parseNewznabResults({ channel: { item: [item()] } });
    expect(r.title).toBe('Show.Name.S01E01.1080p.WEB.x264-GRP');
    expect(r.guid).toBe('abc123');
    expect(r.sizeBytes).toBe(1500000000);
    expect(r.grabs).toBe(42);
    expect(r.categoryId).toBe(5040); // most specific of 5000/5040
    expect(r.pubDate).toBe('Mon, 29 Jun 2026 15:22:00 +0000'); // usenetdate wins
  });

  it('handles a single item object (not an array)', () => {
    expect(parseNewznabResults({ channel: { item: item() } })).toHaveLength(1);
  });

  it('handles a single attr object (not an array)', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: { '@attributes': { name: 'grabs', value: '7' } } })] },
    });
    expect(r[0].grabs).toBe(7);
  });

  it('missing grabs -> null (not 0)', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: [{ '@attributes': { name: 'size', value: '10' } }] })] },
    });
    expect(r[0].grabs).toBeNull();
  });

  it('size falls back to enclosure length when no size attr', () => {
    const r = parseNewznabResults({
      channel: { item: [item({ attr: [{ '@attributes': { name: 'grabs', value: '1' } }] })] },
    });
    expect(r[0].sizeBytes).toBe(1500000000);
  });

  it('strips the NZBGeek apikey from link (no key leaked to the browser)', () => {
    const r = parseNewznabResults({
      channel: {
        item: [item({ link: 'https://api.nzbgeek.info/api?t=get&id=abc123&apikey=REDACTED' })],
      },
    });
    expect(r[0].link).not.toContain('apikey');
    expect(r[0].link).toContain('id=abc123');
  });

  it('skips items with neither guid nor link', () => {
    const r = parseNewznabResults({ channel: { item: [item({ guid: '', link: '' })] } });
    expect(r).toHaveLength(0);
  });

  it('malformed input -> [] (never throws)', () => {
    expect(parseNewznabResults(null)).toEqual([]);
    expect(parseNewznabResults('nope')).toEqual([]);
    expect(parseNewznabResults({})).toEqual([]);
    expect(parseNewznabResults({ channel: {} })).toEqual([]);
  });
});

describe('parseNewznabResults — against the REAL captured fixture', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8')
  );
  const results = parseNewznabResults(raw);

  it('extracts a non-empty result set', () => {
    expect(results.length).toBeGreaterThan(0);
  });

  it('every result has the required fields well-typed', () => {
    for (const r of results) {
      expect(typeof r.guid).toBe('string');
      expect(r.guid.length).toBeGreaterThan(0);
      expect(typeof r.title).toBe('string');
      expect(typeof r.sizeBytes).toBe('number');
      expect(r.grabs === null || typeof r.grabs === 'number').toBe(true);
      expect(r.categoryId === null || typeof r.categoryId === 'number').toBe(true);
    }
  });

  it('REGRESSION: the @attributes-nested read actually populates grabs + size (the bug the flat shape would cause)', () => {
    // At least one real result must have a real grabs number and a real size,
    // proving we read attr[i]["@attributes"], not a flat attr[i].name.
    expect(results.some((r) => typeof r.grabs === 'number' && r.grabs >= 0)).toBe(true);
    expect(results.every((r) => r.sizeBytes > 0)).toBe(true);
  });
});

describe('formatImdbId', () => {
  it('zero-pads NZBGeek imdb to tt#######', () => {
    expect(formatImdbId('01375666')).toBe('tt1375666');
    expect(formatImdbId('00133093')).toBe('tt0133093');
  });
  it('handles 8-digit ids', () => {
    expect(formatImdbId('10872600')).toBe('tt10872600');
  });
  it('returns null for empty/garbage', () => {
    expect(formatImdbId('')).toBeNull();
    expect(formatImdbId(undefined)).toBeNull();
    expect(formatImdbId('tt123')).toBeNull(); // non-numeric -> null, not ttNaN
  });
});

describe('parseNewznabResults — IDs', () => {
  it('extracts imdbId from the real movies fixture', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8')
    );
    const results = parseNewznabResults(raw);
    expect(results.every((r) => r.imdbId === null || /^tt\d{7,}$/.test(r.imdbId))).toBe(true);
    expect(results.some((r) => r.imdbId !== null)).toBe(true);
  });
  it('extracts tvdbId/season/episode from the real TV fixture', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search-tv.json'), 'utf-8')
    );
    const results = parseNewznabResults(raw);
    expect(results.some((r) => r.tvdbId === 361753)).toBe(true);
    expect(results.some((r) => r.season === 1)).toBe(true);
    // a season pack has episode 0 (E00), which must parse to 0, not null
    expect(results.some((r) => r.episode === 0)).toBe(true);
  });
  it('leaves TV ids null on a movie item and vice versa', () => {
    const movies = parseNewznabResults(
      JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/nzbgeek-search.json'), 'utf-8'))
    );
    expect(movies.every((r) => r.tvdbId === null)).toBe(true);
  });
});
