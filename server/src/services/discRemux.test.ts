import { describe, it, expect, vi } from 'vitest';
import {
  isDiscImage,
  classifyDvdProbeFailure,
  findDvdMainTitle,
  parseBlurayDuration,
  remuxQualityName,
  releaseName,
  remuxArgs,
  parseOutTimeUs,
  progressPercent,
  summarizeProbe,
  verifyRemux,
  type TitleProbe,
} from './discRemux';

describe('isDiscImage', () => {
  it('matches .iso and .img case-insensitively', () => {
    expect(isDiscImage('Puss.in.Boots.DVD9-AndreMor.iso')).toBe(true);
    expect(isDiscImage('Dune.2021.COMPLETE.BLURAY.ISO')).toBe(true);
    expect(isDiscImage('movie.img')).toBe(true);
  });
  it('rejects normal video files and non-strings', () => {
    expect(isDiscImage('Movie.2020.1080p.mkv')).toBe(false);
    expect(isDiscImage('iso.mkv')).toBe(false);
    expect(isDiscImage(undefined)).toBe(false);
    expect(isDiscImage(42)).toBe(false);
  });
});

describe('classifyDvdProbeFailure', () => {
  // Real stderr captured from ffprobe 8.1.2 (dvdvideo demuxer).
  it('recognises a file that is not a DVD at all', () => {
    const stderr =
      '[dvdvideo @ 0000019c44284900] libdvdread: DVDOpenFileUDF:UDFFindFile /VIDEO_TS/VIDEO_TS.IFO failed\n' +
      '[dvdvideo @ 0000019c44284900] Unable to open the VMG (VIDEO_TS.IFO)\n';
    expect(classifyDvdProbeFailure(stderr)).toBe('not-dvd');
    expect(classifyDvdProbeFailure('Unable to open the DVD-Video structure')).toBe('not-dvd');
  });
  it('recognises a title number past the last title', () => {
    expect(classifyDvdProbeFailure('[dvdvideo @ 00000183d28832c0] Title 4 not found\n')).toBe('past-end');
  });
  it('treats any other failure as a skippable bad title', () => {
    expect(classifyDvdProbeFailure('Title 2 has invalid headers in VTS')).toBe('skip');
    expect(classifyDvdProbeFailure('')).toBe('skip');
  });
});

describe('findDvdMainTitle', () => {
  const ok = (seconds: number): TitleProbe => ({ ok: true, seconds });
  const fail = (stderr: string): TitleProbe => ({ ok: false, stderr });

  it('returns the longest title and stops at the first title past the end', async () => {
    const results = [ok(20), ok(59.97), ok(10), fail('Title 4 not found')];
    const probe = vi.fn(async (n: number) => results[n - 1]);
    expect(await findDvdMainTitle(probe)).toEqual({ title: 2, seconds: 59.97 });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('skips a broken title in the middle instead of giving up', async () => {
    const results = [ok(300), fail('Title 2 has invalid headers in VTS'), ok(6180), fail('Title 4 not found')];
    expect(await findDvdMainTitle(async (n) => results[n - 1])).toEqual({ title: 3, seconds: 6180 });
  });

  it('returns null immediately for a non-DVD image', async () => {
    const probe = vi.fn(async () => fail('Unable to open the VMG (VIDEO_TS.IFO)'));
    expect(await findDvdMainTitle(probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('gives up after title 99 when every title fails', async () => {
    const probe = vi.fn(async () => fail('Title has invalid headers'));
    expect(await findDvdMainTitle(probe)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(99);
  });

  it('rejects when two titles are within 1 s of the longest (copy protection)', async () => {
    const results = [ok(6180), ok(6180.4), fail('Title 3 not found')];
    await expect(findDvdMainTitle(async (n) => results[n - 1])).rejects.toThrow(/copy protection/);
  });

  it('accepts a near-duplicate more than 1 s shorter than the longest', async () => {
    const results = [ok(6180), ok(6178), fail('Title 3 not found')];
    expect(await findDvdMainTitle(async (n) => results[n - 1])).toEqual({ title: 1, seconds: 6180 });
  });
});

describe('parseBlurayDuration', () => {
  it('reads the selected playlist duration from the real libbluray log', () => {
    const log =
      '[bluray @ 00000202f036c780] 1 usable playlists:\n' +
      '[bluray @ 00000202f036c780] playlist 00000.mpls (0:04:00)\n' +
      '[bluray @ 00000202f036c780] selected 00000.mpls\n';
    expect(parseBlurayDuration(log)).toBe(240);
  });
  it('uses the selected playlist, not the first one listed', () => {
    const log =
      'playlist 00001.mpls (0:03:05)\nplaylist 00800.mpls (2:35:12)\nplaylist 00002.mpls (0:12:00)\nselected 00800.mpls\n';
    expect(parseBlurayDuration(log)).toBe(2 * 3600 + 35 * 60 + 12);
  });
  it('returns null when nothing was selected (no usable playlists)', () => {
    expect(parseBlurayDuration('[bluray @ 0] 0 usable playlists:\n')).toBeNull();
    expect(parseBlurayDuration('selected 00800.mpls\n')).toBeNull();
  });
  it('throws when another playlist shares the selected one\'s exact length (copy protection)', () => {
    const log = 'playlist 00800.mpls (2:35:12)\nplaylist 00801.mpls (2:35:12)\nselected 00800.mpls\n';
    expect(() => parseBlurayDuration(log)).toThrow(/copy protection/);
  });
  it('does not double-count the same playlist logged twice', () => {
    const log = 'playlist 00800.mpls (2:35:12)\nplaylist 00800.mpls (2:35:12)\nselected 00800.mpls\n';
    expect(parseBlurayDuration(log)).toBe(9312);
  });
});

describe('remuxQualityName', () => {
  it('maps DVDs to DVD and Blu-rays to Remux by height', () => {
    expect(remuxQualityName('dvd', null)).toBe('DVD');
    expect(remuxQualityName('bluray', 1080)).toBe('Remux-1080p');
    expect(remuxQualityName('bluray', 2160)).toBe('Remux-2160p');
    expect(remuxQualityName('bluray', null)).toBe('Remux-1080p');
  });
});

describe('releaseName', () => {
  it('builds a Radarr-parseable DVD name from title and year', () => {
    expect(releaseName('Puss in Boots: The Last Wish', 2022, 'dvd', null)).toBe('Puss.in.Boots.The.Last.Wish.2022.DVD');
  });
  it('builds a Blu-ray remux name with resolution', () => {
    expect(releaseName('Dune', 2021, 'bluray', 1080)).toBe('Dune.2021.1080p.BluRay.REMUX');
    expect(releaseName('Dune', 2021, 'bluray', 2160)).toBe('Dune.2021.2160p.BluRay.REMUX');
  });
  it('drops characters Windows forbids and never produces doubled or trailing dots', () => {
    expect(releaseName('AC/DC: Let There Be Rock', 1980, 'dvd', null)).toBe('ACDC.Let.There.Be.Rock.1980.DVD');
    expect(releaseName('Dr. Strangelove', 1964, 'dvd', null)).toBe('Dr.Strangelove.1964.DVD');
    expect(releaseName('What?', 2000, 'dvd', null)).toBe('What.2000.DVD');
    expect(releaseName('Mr.', 2000, 'dvd', null)).toBe('Mr.2000.DVD');
  });
});

describe('remuxArgs', () => {
  it('reads a DVD title with the dvdvideo demuxer', () => {
    const args = remuxArgs('dvd', 'R:\\m\\a.iso', 2, 'R:\\s\\out.mkv.partial');
    expect(args.join(' ')).toContain('-f dvdvideo -title 2 -i R:\\m\\a.iso');
  });
  it('reads a Blu-ray through the bluray protocol with no playlist (ffmpeg picks the longest)', () => {
    const args = remuxArgs('bluray', 'R:\\m\\b.iso', null, 'out.mkv.partial');
    expect(args).toContain('bluray:R:\\m\\b.iso');
    expect(args).not.toContain('-playlist');
    expect(args).not.toContain('dvdvideo');
  });
  it('never prompts, stream-copies every video/audio/subtitle track, and reports progress', () => {
    const args = remuxArgs('dvd', 'a.iso', 1, 'out.mkv.partial');
    for (const flag of ['-nostdin', '-y', '-nostats']) expect(args).toContain(flag);
    expect(args.join(' ')).toContain('-map 0:v -map 0:a -map 0:s? -c copy');
    expect(args.join(' ')).toContain('-f matroska -progress pipe:1');
    expect(args[args.length - 1]).toBe('out.mkv.partial');
  });
});

describe('parseOutTimeUs / progressPercent', () => {
  it('parses out_time_us lines only', () => {
    expect(parseOutTimeUs('out_time_us=59993267')).toBe(59993267);
    expect(parseOutTimeUs('out_time_us=N/A')).toBeNull();
    expect(parseOutTimeUs('out_time_us=-9223372036854775807')).toBeNull();
    expect(parseOutTimeUs('out_time_ms=59993267')).toBeNull();
    expect(parseOutTimeUs('progress=end')).toBeNull();
  });
  it('turns written time into a percent of the source, capped at 99', () => {
    expect(progressPercent(120_000_000, 240)).toBe(50);
    expect(progressPercent(240_000_000, 240)).toBe(99);
    expect(progressPercent(999_000_000, 240)).toBe(99);
    expect(progressPercent(1, 0)).toBe(0);
  });
});

describe('summarizeProbe', () => {
  it('summarises real ffprobe JSON for a remuxed MKV', () => {
    const json = {
      streams: [
        { codec_type: 'video', height: 1080 },
        { codec_type: 'audio' },
      ],
      format: { duration: '240.032000' },
    };
    expect(summarizeProbe(json)).toEqual({ seconds: 240.032, hasVideo: true, hasAudio: true, height: 1080 });
  });
  it('is safe on garbage', () => {
    expect(summarizeProbe(null)).toEqual({ seconds: 0, hasVideo: false, hasAudio: false, height: null });
    expect(summarizeProbe({ streams: 'x', format: { duration: 'N/A' } })).toEqual({
      seconds: 0, hasVideo: false, hasAudio: false, height: null,
    });
  });
});

describe('verifyRemux', () => {
  const good = { seconds: 6150, hasVideo: true, hasAudio: true, height: 480 };

  it('passes a complete remux of the right title', () => {
    expect(verifyRemux(good, 6180, 103)).toBeNull();
  });
  it('fails when a track type is missing', () => {
    expect(verifyRemux({ ...good, hasAudio: false }, 6180, 103)).toMatch(/video or audio/);
    expect(verifyRemux({ ...good, hasVideo: false }, 6180, 103)).toMatch(/video or audio/);
  });
  it('fails a truncated read (under 97% of the disc feature)', () => {
    expect(verifyRemux({ ...good, seconds: 5000 }, 6180, 103)).toMatch(/incomplete/);
  });
  it('fails when the length does not fit Radarr runtime (wrong title)', () => {
    // self-consistent remux of a 40-minute bonus feature
    expect(verifyRemux({ ...good, seconds: 2400 }, 2400, 103)).toMatch(/wrong title/);
    // a 4-hour obfuscation playlist
    expect(verifyRemux({ ...good, seconds: 14400 }, 14400, 103)).toMatch(/wrong title/);
  });
  it('skips the runtime check when Radarr has no runtime', () => {
    expect(verifyRemux({ ...good, seconds: 2400 }, 2400, 0)).toBeNull();
    expect(verifyRemux({ ...good, seconds: 2400 }, 2400, undefined)).toBeNull();
  });
});
