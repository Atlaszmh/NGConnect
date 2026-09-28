# Convert Disc Images for Plex — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Convert for Plex" button on disc-image movies that remuxes the DVD/Blu-ray ISO's main feature into an MKV with ffmpeg and swaps it in via Radarr's ManualImport.

**Architecture:** Pure, unit-tested helpers in `server/src/services/discRemux.ts`; side effects (ffmpeg/ffprobe processes, Radarr API, filesystem, the single in-memory job) in `server/src/services/remuxJob.ts`; two endpoints on the existing `systemRouter`; the Movies page gets a badge, a button and a polled status line.

**Tech Stack:** Express 5 + TypeScript (commonjs, ES2022), vitest, React 19 + Vite, Node `child_process`/`fs`/`readline`, ffmpeg full build (`dvdvideo` demuxer, `bluray:` protocol).

**Spec:** `docs/superpowers/specs/2026-09-28-disc-image-remux-design.md` — read it first; this plan implements it exactly.

**Repo facts an implementer needs:**
- Files use **CRLF** line endings (`core.autocrlf=true`). Edit with tools that preserve them.
- Server tests: `cd server && npx vitest run <file>`. Server typecheck: `cd server && npx tsc --noEmit -p .`. Client typecheck+build: `cd client && npm run build`.
- The dev PC cannot reach Radarr (arrs are localhost-only on the server PC). Radarr calls are exercised live only, by the user.
- The dev PC has the full ffmpeg build on PATH, and two authored test ISOs exist in the session scratchpad (`dvdtest\test.iso`: 3 DVD titles of 20 s / 60 s / 10 s; `bdtest\test-bd.iso`: one 4-min 1080p Blu-ray playlist). Task 4 uses them.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## File map

| File | Responsibility |
|---|---|
| `server/src/services/discRemux.ts` (new) | Pure helpers: disc detection, DVD probe classification + main-title search, Blu-ray log parsing, naming, quality choice, ffmpeg args, progress parsing, probe summary, verification rule |
| `server/src/services/discRemux.test.ts` (new) | vitest for every helper above |
| `server/src/services/importScan.ts` (modify) | export `fetchSabCompleteDir` for reuse |
| `server/src/services/remuxJob.ts` (new) | ffmpeg availability check, disc probing, remux process with progress + watchdog, Radarr swap, the job/lock, `startRemux` / `getRemuxStatus` |
| `server/src/routes/system.ts` (modify) | `GET/POST /api/system/remux` |
| `client/src/pages/MoviesPage.tsx` (modify) | badge, Convert button, status line, polling |
| `client/src/index.css` (modify) | `.movie-remux` status line style |
| `CLAUDE.md` (modify) | server-PC ffmpeg requirement |
| `tools/remux-dvd-iso.ps1` (delete, untracked) | superseded |

---

## Chunk 1: Pure helpers

### Task 1: `discRemux.ts` helpers (TDD)

**Files:**
- Create: `server/src/services/discRemux.test.ts`
- Create: `server/src/services/discRemux.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/discRemux.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/services/discRemux.test.ts`
Expected: FAIL — `Failed to resolve import "./discRemux"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/discRemux.ts`:

```ts
// Pure helpers for converting a disc-image movie (DVD/Blu-ray ISO) into an MKV
// Plex can play. Side effects (ffmpeg, Radarr, filesystem) live in remuxJob.ts.

export type DiscKind = 'dvd' | 'bluray';

export function isDiscImage(relativePath: unknown): boolean {
  return typeof relativePath === 'string' && /\.(iso|img)$/i.test(relativePath);
}

// Classify a failed `ffprobe -f dvdvideo -title N` by its stderr. Messages come
// from ffmpeg's libavformat/dvdvideodec.c.
export function classifyDvdProbeFailure(stderr: string): 'not-dvd' | 'past-end' | 'skip' {
  if (/Unable to open the (VMG|DVD-Video structure)/.test(stderr)) return 'not-dvd';
  if (/Title \d+ not found/.test(stderr)) return 'past-end';
  return 'skip';
}

export type TitleProbe = { ok: true; seconds: number } | { ok: false; stderr: string };

// The longest DVD title is the main feature. Stops at the first title past the
// end; a title that fails for any other reason (bad headers, probe timeout) is
// skipped. Returns null for a non-DVD image or when no title opens.
// ponytail: copy-protected discs with many same-length decoy titles can still
// fool "longest"; verifyRemux's runtime check only catches wrong-length picks.
export async function findDvdMainTitle(
  probe: (title: number) => Promise<TitleProbe>,
): Promise<{ title: number; seconds: number } | null> {
  let best: { title: number; seconds: number } | null = null;
  for (let title = 1; title <= 99; title++) {
    const result = await probe(title);
    if (result.ok) {
      if (!best || result.seconds > best.seconds) best = { title, seconds: result.seconds };
      continue;
    }
    const failure = classifyDvdProbeFailure(result.stderr);
    if (failure === 'not-dvd') return best;
    if (failure === 'past-end') break;
  }
  return best;
}

// libbluray (through ffmpeg's bluray: protocol) logs "playlist 00800.mpls (2:35:12)"
// for each usable playlist, then "selected 00800.mpls" — the longest, which
// ffmpeg picks itself when no -playlist is given (libavformat/bluray.c).
export function parseBlurayDuration(log: string): number | null {
  const selected = /selected (\d+)\.mpls/.exec(log)?.[1];
  if (!selected) return null;
  const m = new RegExp(`playlist ${selected}\\.mpls \\((\\d+):(\\d\\d):(\\d\\d)\\)`).exec(log);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export type RemuxQuality = 'DVD' | 'Remux-1080p' | 'Remux-2160p';

export function remuxQualityName(kind: DiscKind, height: number | null): RemuxQuality {
  if (kind === 'dvd') return 'DVD';
  return height !== null && height > 1080 ? 'Remux-2160p' : 'Remux-1080p';
}

// Staging folder/file name. It parses (Radarr's QualityParser) to the same
// quality ManualImport is told explicitly, so a manual "Scan download folder"
// recovery would label the file the same way. No "-GROUP" suffix on purpose:
// "DVD-R..." would parse as the DVD-R disc quality.
export function releaseName(title: string, year: number, kind: DiscKind, height: number | null): string {
  const safe = title
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/\s+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
  if (kind === 'dvd') return `${safe}.${year}.DVD`;
  const res = remuxQualityName(kind, height) === 'Remux-2160p' ? '2160p' : '1080p';
  return `${safe}.${year}.${res}.BluRay.REMUX`;
}

// ffmpeg arguments for a stream-copy remux. -nostdin/-y: never block on a
// prompt (a .partial left by an interrupted run is simply overwritten).
export function remuxArgs(kind: DiscKind, iso: string, title: number | null, out: string): string[] {
  const input =
    kind === 'dvd' ? ['-f', 'dvdvideo', '-title', String(title ?? 1), '-i', iso] : ['-i', `bluray:${iso}`];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...input,
    '-map', '0:v', '-map', '0:a', '-map', '0:s?',
    '-c', 'copy', '-max_muxing_queue_size', '4096',
    '-f', 'matroska', '-progress', 'pipe:1', '-nostats',
    out,
  ];
}

// `-progress pipe:1` emits key=value lines; out_time_us is microseconds written.
export function parseOutTimeUs(line: string): number | null {
  const m = /^out_time_us=(\d+)$/.exec(line.trim());
  return m ? Number(m[1]) : null;
}

// Capped at 99: 100 is reported only once ffmpeg has exited cleanly.
export function progressPercent(outTimeUs: number, sourceSeconds: number): number {
  if (!(sourceSeconds > 0)) return 0;
  return Math.min(99, Math.floor((outTimeUs / 1e6 / sourceSeconds) * 100));
}

export interface ProbeSummary {
  seconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  height: number | null;
}

// Summarise `ffprobe -show_entries format=duration:stream=codec_type,height -of json`.
export function summarizeProbe(json: unknown): ProbeSummary {
  const j = json as { format?: { duration?: unknown }; streams?: unknown } | null;
  const streams = Array.isArray(j?.streams) ? (j.streams as Array<{ codec_type?: unknown; height?: unknown }>) : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  const seconds = Number(j?.format?.duration);
  return {
    seconds: Number.isFinite(seconds) ? seconds : 0,
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s?.codec_type === 'audio'),
    height: typeof video?.height === 'number' ? video.height : null,
  };
}

// Last gate before Radarr replaces the disc image (its recycle bin may be off).
// Returns why the MKV is unsafe to import, or null when it passes.
export function verifyRemux(
  out: ProbeSummary,
  sourceSeconds: number,
  runtimeMinutes: number | null | undefined,
): string | null {
  const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
  if (!out.hasVideo || !out.hasAudio) return 'the MKV is missing a video or audio track';
  if (out.seconds < sourceSeconds * 0.97) {
    return `the MKV is ${mins(out.seconds)} but the disc's feature is ${mins(sourceSeconds)} (incomplete read)`;
  }
  if (runtimeMinutes && runtimeMinutes > 0) {
    const ratio = out.seconds / (runtimeMinutes * 60);
    if (ratio < 0.8 || ratio > 1.3) {
      return `the MKV is ${mins(out.seconds)} but Radarr lists the movie at ${runtimeMinutes} min (wrong title?)`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/services/discRemux.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/discRemux.ts server/src/services/discRemux.test.ts
git commit -m "feat(server): pure helpers for disc-image remux (probe classify, naming, args, verify)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 2: Job runner, endpoints, local end-to-end

### Task 2: Export `fetchSabCompleteDir`

**Files:**
- Modify: `server/src/services/importScan.ts` (the `async function fetchSabCompleteDir` line)

- [ ] **Step 1:** Change `async function fetchSabCompleteDir(): Promise<string> {` to `export async function fetchSabCompleteDir(): Promise<string> {`. No other change.

- [ ] **Step 2:** Run `cd server && npx tsc --noEmit -p .` — expected: no output, exit 0.

(Committed together with Task 3.)

### Task 3: `remuxJob.ts`

**Files:**
- Create: `server/src/services/remuxJob.ts`

No unit tests here (processes, Radarr, fs); the pure logic is already covered by Task 1, and Task 4 exercises the process code against real ISOs.

- [ ] **Step 1: Write the module**

Create `server/src/services/remuxJob.ts`:

```ts
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import { commandStatus, fetchSabCompleteDir, isTerminal } from './importScan';
import { createServiceLogger } from './logger';
import {
  findDvdMainTitle,
  isDiscImage,
  parseBlurayDuration,
  parseOutTimeUs,
  progressPercent,
  releaseName,
  remuxArgs,
  remuxQualityName,
  summarizeProbe,
  verifyRemux,
} from './discRemux';
import type { DiscKind, ProbeSummary, TitleProbe } from './discRemux';

const log = createServiceLogger('remux');

export type RemuxStage = 'probing' | 'remuxing' | 'verifying' | 'importing' | 'done' | 'failed';

export interface RemuxJob {
  movieId: number;
  title: string;
  stage: RemuxStage;
  percent: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FfmpegStatus {
  ok: boolean;
  dvd: boolean;
  bluray: boolean;
  hint: string | null;
}

export interface DiscProbe {
  kind: DiscKind;
  title: number | null;
  sourceSeconds: number;
  height: number | null;
}

// Carries the HTTP status the route should answer with.
export class RemuxError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface MovieFile {
  id: number;
  path?: string;
  relativePath?: string;
  size?: number;
  releaseGroup?: string;
  languages?: unknown[];
}

interface Movie {
  id: number;
  title: string;
  year: number;
  runtime?: number;
  movieFile?: MovieFile;
}

const FFMPEG_HINT =
  'ffmpeg (full build) is needed on the server PC: run "winget install Gyan.FFmpeg", then restart ' +
  'NGConnect. If it is still not found, set FFMPEG_PATH in .env to the full path of ffmpeg.exe.';
const STALL_MS = 5 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 60 * 60 * 1000;

// ponytail: one job, held in memory. A server restart (e.g. an auto-deploy)
// mid-job loses it and leaves a .partial in staging; re-running overwrites it.
let job: RemuxJob | null = null;
let busy = false; // claimed before the first await so two POSTs can't both start
let ffmpegVerified = false;

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = () =>
  process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe.exe') : 'ffprobe';

interface RunResult {
  code: number | null; // null = killed by the timeout
  stdout: string;
  stderr: string;
}

// Resolves with the exit code instead of rejecting, because callers classify
// ffprobe failures from stderr. Rejects only when the binary can't start.
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (typeof err.code === 'string') return reject(err);
      resolve({ code: typeof err.code === 'number' ? err.code : null, stdout, stderr });
    });
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function radarr<T>(apiPath: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.radarr.url}/api/v3${apiPath}`, {
    ...init,
    headers: { 'X-Api-Key': config.radarr.apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Radarr ${init.method ?? 'GET'} ${apiPath} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function checkFfmpeg(): Promise<FfmpegStatus> {
  if (ffmpegVerified) return { ok: true, dvd: true, bluray: true, hint: null };
  try {
    const [demuxers, protocols, ffprobe] = await Promise.all([
      run(ffmpegBin(), ['-hide_banner', '-demuxers'], 15000),
      run(ffmpegBin(), ['-hide_banner', '-protocols'], 15000),
      run(ffprobeBin(), ['-version'], 15000), // rejects (ENOENT) if ffprobe isn't there
    ]);
    const dvd = /\bdvdvideo\b/.test(demuxers.stdout);
    const bluray = /\bbluray\b/.test(protocols.stdout);
    ffmpegVerified = dvd && bluray && ffprobe.code === 0;
    return { ok: ffmpegVerified, dvd, bluray, hint: ffmpegVerified ? null : FFMPEG_HINT };
  } catch {
    return { ok: false, dvd: false, bluray: false, hint: FFMPEG_HINT };
  }
}

async function probeDvdTitle(iso: string, title: number): Promise<TitleProbe> {
  const r = await run(
    ffprobeBin(),
    ['-v', 'error', '-f', 'dvdvideo', '-title', String(title), '-show_entries', 'format=duration', '-of', 'json', '-i', iso],
    30000,
  );
  const seconds = r.code === 0 ? summarizeProbe(safeJson(r.stdout)).seconds : 0;
  return seconds > 0 ? { ok: true, seconds } : { ok: false, stderr: r.stderr };
}

// DVD first (cheap per-title probes); anything that isn't a DVD is tried as a
// Blu-ray. null = neither opened.
export async function probeDisc(iso: string): Promise<DiscProbe | null> {
  const dvd = await findDvdMainTitle((n) => probeDvdTitle(iso, n));
  if (dvd) return { kind: 'dvd', title: dvd.title, sourceSeconds: dvd.seconds, height: null };
  const r = await run(
    ffprobeBin(),
    ['-hide_banner', '-v', 'info', '-show_entries', 'stream=codec_type,height', '-of', 'json', '-i', `bluray:${iso}`],
    120000,
  );
  const seconds = r.code === 0 ? parseBlurayDuration(r.stderr) : null;
  if (!seconds) return null;
  return { kind: 'bluray', title: null, sourceSeconds: seconds, height: summarizeProbe(safeJson(r.stdout)).height };
}

// Run the ffmpeg remux, reporting percent. A watchdog kills ffmpeg if its
// written time stops advancing for STALL_MS.
export function runRemux(args: string[], sourceSeconds: number, onPercent: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let lastStderr = '';
    let lastOutUs = -1;
    let lastAdvance = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastAdvance > STALL_MS) {
        stalled = true;
        child.kill();
      }
    }, 15000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const us = parseOutTimeUs(line);
      if (us === null) return;
      if (us > lastOutUs) {
        lastOutUs = us;
        lastAdvance = Date.now();
      }
      onPercent(progressPercent(us, sourceSeconds));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) lastStderr = lines[lines.length - 1];
    });
    child.on('error', (err) => {
      clearInterval(watchdog);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      if (code === 0) resolve();
      else if (stalled) reject(new Error('ffmpeg stopped making progress for 5 minutes'));
      else reject(new Error(`ffmpeg failed (exit ${code})${lastStderr ? `: ${lastStderr}` : ''}`));
    });
  });
}

export async function probeOutput(file: string): Promise<ProbeSummary> {
  const r = await run(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,height', '-of', 'json', file],
    120000,
  );
  return summarizeProbe(r.code === 0 ? safeJson(r.stdout) : null);
}

// ManualImport builds its ImportDecision with no rejection checks, so a DVD MKV
// can replace a (higher-ranked) DVD-R ISO; Radarr removes the ISO inside this
// same import (UpgradeMovieFile) and notifies Plex.
async function importIntoRadarr(movieId: number, mkv: string, release: string, disc: DiscProbe, file: MovieFile) {
  const qualityName = remuxQualityName(disc.kind, disc.height);
  const defs = await radarr<Array<{ quality?: { name?: string } }>>('/qualitydefinition');
  const def = defs.find((d) => d.quality?.name === qualityName);
  if (!def?.quality) throw new Error(`Radarr has no "${qualityName}" quality.`);
  const cmd = await radarr<{ id: number }>('/command', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ManualImport',
      importMode: 'Move',
      files: [
        {
          path: mkv,
          movieId,
          folderName: release,
          quality: { quality: def.quality, revision: { version: 1, real: 0, isRepack: false } },
          languages: file.languages ?? [],
          releaseGroup: file.releaseGroup ?? '',
        },
      ],
    }),
  });
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let status: string | null = null;
    try {
      status = commandStatus(await radarr<unknown>(`/command/${cmd.id}`));
    } catch {
      /* one slow/failed poll must not fail the job while Radarr keeps importing */
    }
    if (status !== null && isTerminal(status)) {
      if (status !== 'completed') throw new Error(`Radarr import ${status}.`);
      return;
    }
    if (Date.now() > deadline) throw new Error('Radarr import still running after 60 min — check Radarr > Activity.');
  }
}

async function runJob(current: RemuxJob, movie: Movie, file: MovieFile & { path: string }, stagingRoot: string) {
  const set = (patch: Partial<RemuxJob>) => Object.assign(current, patch);
  let partial: string | null = null; // deleted on failure; null once it is a verified MKV
  let verifiedMkv: string | null = null; // kept on failure; every later error says where it is
  try {
    const disc = await probeDisc(file.path);
    if (!disc) throw new Error('Not a readable DVD or Blu-ray image');
    const release = releaseName(movie.title, movie.year, disc.kind, disc.height);
    const dir = path.join(stagingRoot, release);
    await fs.promises.mkdir(dir, { recursive: true });
    const mkv = path.join(dir, `${release}.mkv`);
    partial = `${mkv}.partial`;

    set({ stage: 'remuxing', percent: 0 });
    await runRemux(remuxArgs(disc.kind, file.path, disc.title, partial), disc.sourceSeconds, (percent) => set({ percent }));

    set({ stage: 'verifying', percent: null });
    const problem = verifyRemux(await probeOutput(partial), disc.sourceSeconds, movie.runtime);
    if (problem) throw new Error(`Check failed: ${problem}. The disc image was not touched.`);
    await fs.promises.rename(partial, mkv);
    partial = null;
    verifiedMkv = mkv;

    set({ stage: 'importing' });
    const before = await radarr<Movie>(`/movie/${movie.id}`);
    if (before.movieFile?.id !== file.id) {
      throw new Error("The movie's file changed during the conversion, so nothing was replaced.");
    }
    await importIntoRadarr(movie.id, mkv, release, disc, file);
    const after = await radarr<Movie>(`/movie/${movie.id}`);
    const imported = after.movieFile?.relativePath;
    if (!imported?.toLowerCase().endsWith('.mkv')) throw new Error('Radarr did not import the MKV.');

    // Best-effort, non-recursive: never removes a file, never fails the job.
    await fs.promises.rmdir(dir).catch(() => {});
    await fs.promises.rmdir(stagingRoot).catch(() => {});
    set({ stage: 'done', percent: 100, message: `Imported as ${imported}`, finishedAt: new Date().toISOString() });
    log.info(`Converted ${movie.title} (${movie.year}) → ${imported}`);
  } catch (err) {
    if (partial) await fs.promises.rm(partial, { force: true }).catch(() => {});
    let message = err instanceof Error ? err.message : String(err);
    if (verifiedMkv) message += ` The MKV is at ${verifiedMkv}`;
    set({ stage: 'failed', percent: null, message, finishedAt: new Date().toISOString() });
    log.error(`Conversion of ${movie.title} (${movie.year}) failed: ${message}`);
  }
}

// Validates synchronously-ish (steps 1–3 of the spec), then runs the job in the
// background. Throws RemuxError for answers the route should pass through.
export async function startRemux(movieId: number): Promise<RemuxJob> {
  if (busy) throw new RemuxError(409, 'A conversion is already running');
  busy = true;
  try {
    const movie = await radarr<Movie>(`/movie/${movieId}`);
    const file = movie.movieFile;
    if (!file?.path || !isDiscImage(file.relativePath)) {
      throw new RemuxError(400, `${movie.title} is not a disc image`);
    }
    const ffmpeg = await checkFfmpeg();
    if (!ffmpeg.ok) throw new RemuxError(503, ffmpeg.hint ?? FFMPEG_HINT);
    const stagingRoot = path.join(await fetchSabCompleteDir(), 'ngconnect-remux');
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const { bavail, bsize } = await fs.promises.statfs(stagingRoot);
    const needed = (file.size ?? 0) + 1e9;
    if (bavail * bsize < needed) {
      throw new RemuxError(507, `Not enough free space in ${stagingRoot}: need ${(needed / 1e9).toFixed(1)} GB`);
    }
    const current: RemuxJob = {
      movieId,
      title: movie.title,
      stage: 'probing',
      percent: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    job = current;
    void runJob(current, movie, { ...file, path: file.path }, stagingRoot).finally(() => {
      busy = false;
    });
    return { ...current };
  } catch (err) {
    busy = false;
    throw err;
  }
}

export async function getRemuxStatus(): Promise<{ ffmpeg: FfmpegStatus; job: RemuxJob | null }> {
  return { ffmpeg: await checkFfmpeg(), job: job && { ...job } };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc --noEmit -p .`
Expected: no output, exit 0.

- [ ] **Step 3: Run the whole server suite (nothing regressed)**

Run: `cd server && npx vitest run`
Expected: all test files pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/importScan.ts server/src/services/remuxJob.ts
git commit -m "feat(server): disc-image remux job (ffmpeg probe/remux/verify, Radarr ManualImport swap)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: Local end-to-end of the process code against real ISOs

Exercises `probeDisc`, `runRemux`, `probeOutput` and `verifyRemux` from the real modules against the two authored ISOs (Radarr is not involved). Nothing is committed.

**Files:**
- Create (scratchpad, not in repo): `<scratchpad>/e2e-remux.ts`

- [ ] **Step 1: Write the script** (replace `<SP>` with the session scratchpad path, forward slashes)

```ts
import { probeDisc, runRemux, probeOutput } from 'C:/Projects/NGConnect/server/src/services/remuxJob';
import { remuxArgs, verifyRemux, releaseName } from 'C:/Projects/NGConnect/server/src/services/discRemux';

async function one(iso: string, title: string, year: number, runtimeMin: number) {
  const disc = await probeDisc(iso);
  console.log('probe', iso.split('/').pop(), disc);
  if (!disc) throw new Error('probe failed');
  const out = `<SP>/${releaseName(title, year, disc.kind, disc.height)}.mkv.partial`;
  let last = -1;
  await runRemux(remuxArgs(disc.kind, iso, disc.title, out), disc.sourceSeconds, (p) => {
    if (p !== last) { last = p; }
  });
  const summary = await probeOutput(out);
  console.log('output', summary, 'last percent', last, 'verify:', verifyRemux(summary, disc.sourceSeconds, runtimeMin) ?? 'PASS');
}

(async () => {
  await one('<SP>/dvdtest/test.iso', 'Test DVD', 2024, 1);   // expect dvd, title 2, ~60 s
  await one('<SP>/bdtest/test-bd.iso', 'Test BD', 2024, 4);  // expect bluray, 240 s, height 1080
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `cd server && npx tsx <SP>/e2e-remux.ts`
Expected:
- `probe test.iso { kind: 'dvd', title: 2, sourceSeconds: 59.96..., height: null }`, output ~60 s with video+audio, `verify: PASS`
- `probe test-bd.iso { kind: 'bluray', title: null, sourceSeconds: 240, height: 1080 }`, output ~240 s, `verify: PASS`
- `last percent` is 99 for both (100 is only set by the job on success).

If either fails, stop and fix before continuing.

### Task 5: Endpoints

**Files:**
- Modify: `server/src/routes/system.ts` (imports at the top; new routes after the import-scan routes at the end of the file)

- [ ] **Step 1: Add the import** below the existing `import { startImportScan, getImportScanStatus } from '../services/importScan';` line:

```ts
import { getRemuxStatus, startRemux, RemuxError } from '../services/remuxJob';
```

- [ ] **Step 2: Append the routes** at the end of the file:

```ts

// Convert a disc-image movie (DVD/Blu-ray ISO) into an MKV Plex can play, then
// swap it in via Radarr. One job at a time; the client polls GET for progress.
systemRouter.get('/remux', async (_req: Request, res: Response) => {
  res.json(await getRemuxStatus());
});

systemRouter.post('/remux', async (req: Request, res: Response) => {
  const movieId = Number(req.body?.movieId);
  if (!Number.isInteger(movieId) || movieId <= 0) {
    res.status(400).json({ error: 'movieId (positive integer) is required' });
    return;
  }
  try {
    res.status(202).json({ job: await startRemux(movieId) });
  } catch (error) {
    const status = error instanceof RemuxError ? error.status : 502;
    const message = error instanceof Error ? error.message : 'Conversion failed to start';
    console.error('remux start error:', message);
    res.status(status).json({ error: message });
  }
});
```

- [ ] **Step 3: Typecheck + tests**

Run: `cd server && npx tsc --noEmit -p . && npx vitest run`
Expected: tsc clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/system.ts
git commit -m "feat(server): GET/POST /api/system/remux" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 3: Client

### Task 6: Movies page badge, button, status line, polling

**Files:**
- Modify: `client/src/pages/MoviesPage.tsx`
- Modify: `client/src/index.css` (after the `.movie-meta` rule)

- [ ] **Step 1: Imports and types.** Replace the first two import lines and the `Movie` interface's `movieFile` line, and add the remux types after `type AddState ...`:

```tsx
import { useEffect, useState } from 'react';
import { Search, RefreshCw, Plus, Download, Trash2, Film } from 'lucide-react';
```

```tsx
  movieFile?: { quality?: { quality?: { name: string } }; size: number; relativePath?: string };
```

```tsx
type RemuxStage = 'probing' | 'remuxing' | 'verifying' | 'importing' | 'done' | 'failed';

interface RemuxJob {
  movieId: number;
  stage: RemuxStage;
  percent: number | null;
  message: string | null;
}

interface RemuxStatus {
  ffmpeg: { ok: boolean; hint: string | null };
  job: RemuxJob | null;
}

const isDiscImage = (m: Movie) => /\.(iso|img)$/i.test(m.movieFile?.relativePath ?? '');
const isActive = (j: RemuxJob | null | undefined) => !!j && j.stage !== 'done' && j.stage !== 'failed';

function remuxLabel(j: RemuxJob): string {
  switch (j.stage) {
    case 'probing': return 'Reading disc…';
    case 'remuxing': return `Converting ${j.percent ?? 0}%`;
    case 'verifying': return 'Checking…';
    case 'importing': return 'Importing…';
    case 'done': return 'Converted for Plex';
    case 'failed': return 'Conversion failed';
  }
}
```

- [ ] **Step 2: State, fetch, polling, start.** After `const [removing, setRemoving] = useState<number | null>(null);` add:

```tsx
  const [remux, setRemux] = useState<RemuxStatus | null>(null);
```

Replace the mount effect `useEffect(() => { fetchMovies(); }, []);` with:

```tsx
  useEffect(() => {
    fetchMovies();
    fetchRemux();
  }, []);

  // Poll only while a conversion runs. A poll that sees the job finish as
  // 'done' refetches movies (the disc-image badge goes away); a 'done' job
  // already in memory on mount does not trigger a refetch.
  const remuxActive = isActive(remux?.job);
  useEffect(() => {
    if (!remuxActive) return;
    const t = setInterval(async () => {
      try {
        const res = await api.get('/system/remux');
        setRemux(res.data);
        if (res.data?.job?.stage === 'done') fetchMovies();
      } catch {
        /* transient poll failure — keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [remuxActive]);
```

After the `fetchMovies` function add:

```tsx
  const fetchRemux = async () => {
    try {
      const res = await api.get('/system/remux');
      setRemux(res.data);
    } catch {
      setRemux(null);
    }
  };

  // Remux the disc's main feature into an MKV Plex can play; the server swaps
  // it in for the disc image through Radarr once it checks out.
  const convertMovie = async (m: Movie) => {
    if (
      !window.confirm(
        `Convert "${m.title} (${m.year})" for Plex?\n\n` +
          "The disc's main feature is copied into an MKV (no quality loss). If it checks out, " +
          'Radarr replaces the disc image with it. This can take 10–40 minutes.',
      )
    ) return;
    try {
      const res = await api.post('/system/remux', { movieId: m.id });
      setRemux((prev) => ({ ffmpeg: prev?.ffmpeg ?? { ok: true, hint: null }, job: res.data.job }));
    } catch (err) {
      window.alert(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not start the conversion',
      );
      fetchRemux(); // e.g. a 409: pick up the job that is already running
    }
  };
```

- [ ] **Step 3: Card.** Inside `filtered.map((m) => (` change the arrow to a block body so per-card values can be computed, and update the overlay buttons, meta and status line. The whole card becomes:

```tsx
          {filtered.map((m) => {
            const disc = isDiscImage(m);
            const myJob = remux?.job?.movieId === m.id ? remux.job : null;
            const converting = isActive(myJob);
            return (
              <div key={m.id} className="movie-card">
                <div className="movie-poster-wrap">
                  {getPoster(m) ? (
                    <img
                      className="movie-poster"
                      src={getPoster(m)}
                      alt={m.title}
                    />
                  ) : (
                    <div className="movie-poster-placeholder">{m.title[0]}</div>
                  )}
                  <div className="movie-overlay">
                    <button
                      className="btn-sm"
                      onClick={() => triggerSearch(m.id)}
                      disabled={searching === m.id || converting}
                    >
                      <Download size={14} />
                      {searching === m.id ? 'Searching...' : 'Search'}
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() => removeMovie(m)}
                      disabled={removing === m.id || converting}
                      title="Remove from Radarr and delete files"
                    >
                      <Trash2 size={14} />
                      {removing === m.id ? 'Removing...' : 'Remove'}
                    </button>
                    {disc && (
                      <button
                        className="btn-sm"
                        onClick={() => convertMovie(m)}
                        disabled={remuxActive || !remux?.ffmpeg.ok}
                        title={
                          remux?.ffmpeg.ok
                            ? 'Remux the disc into an MKV Plex can play'
                            : remux?.ffmpeg.hint ?? 'Checking for ffmpeg…'
                        }
                      >
                        <Film size={14} />
                        {converting && myJob ? remuxLabel(myJob) : 'Convert for Plex'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="movie-info">
                  <div className="movie-title">{m.title}</div>
                  <div className="movie-meta">
                    {m.year}
                    {m.hasFile && (
                      <>
                        {' '}&middot;{' '}
                        <span className="badge badge-success">Downloaded</span>
                        {m.sizeOnDisk ? ` ${formatSize(m.sizeOnDisk)}` : ''}
                      </>
                    )}
                    {!m.hasFile && m.monitored && (
                      <>
                        {' '}&middot;{' '}
                        <span className="badge badge-warning">Missing</span>
                      </>
                    )}
                    {disc && (
                      <>
                        {' '}&middot;{' '}
                        <span className="badge badge-warning" title="Plex can't play disc images">
                          Disc image
                        </span>
                      </>
                    )}
                  </div>
                  {myJob && (
                    <div className={`movie-remux${myJob.stage === 'failed' ? ' failed' : ''}`}>
                      {remuxLabel(myJob)}
                      {myJob.message ? ` — ${myJob.message}` : ''}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
```

- [ ] **Step 4: CSS.** In `client/src/index.css`, add `flex-wrap: wrap;` to the existing `.movie-overlay` rule (directly after its `justify-content: center;` line) — three buttons don't fit a 140–160 px card on one row and `.movie-poster-wrap` clips overflow. Then, directly after the `.movie-meta { ... }` rule, add:

```css
.movie-remux {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 4px;
  overflow-wrap: anywhere;
}

.movie-remux.failed {
  color: var(--color-danger);
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd client && npm run build`
Expected: `✓ built in ...`, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/MoviesPage.tsx client/src/index.css
git commit -m "feat(client): Convert for Plex on disc-image movies (badge, progress, polling)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 4: Cleanup and docs

### Task 7: Remove the superseded script, document the server-PC requirement

**Files:**
- Delete: `tools/remux-dvd-iso.ps1` (untracked) and the then-empty `tools/` folder
- Modify: `CLAUDE.md` (the `## Media Stack Configuration` bullet list)

- [ ] **Step 1:** Delete `tools/remux-dvd-iso.ps1` and the empty `tools/` directory.

- [ ] **Step 2:** In `CLAUDE.md`, append this bullet to the `## Media Stack Configuration` list (after the Plex Connect bullet):

```markdown
- **ffmpeg (full build) on the server PC** powers "Convert for Plex" on disc-image movies (`server/src/services/remuxJob.ts`): `winget install Gyan.FFmpeg`, then restart NGConnect. If NGConnect can't find it on PATH, set `FFMPEG_PATH` in `.env` to `ffmpeg.exe` (ffprobe must sit next to it). The essentials build lacks DVD/Blu-ray support.
```

- [ ] **Step 3: Final verification**

Run: `cd server && npx tsc --noEmit -p . && npx vitest run` then `cd ../client && npm run build`
Expected: tsc clean, all server tests pass, client builds.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: server-PC ffmpeg requirement for Convert for Plex" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

## After the plan (user steps, not agent steps)

1. On the server PC: `winget install Gyan.FFmpeg`, restart NGConnect (or push/deploy, which restarts it).
2. Enable Radarr's recycle bin (Settings > Media Management > Recycling Bin) before the first live run.
3. Push to `origin/main`; the Movies page shows the ffmpeg hint until step 1 is done.
4. First live runs: Puss in Boots (DVD), then Dune (Blu-ray).
