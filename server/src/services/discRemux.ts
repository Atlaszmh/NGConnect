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

// Thrown by findDvdMainTitle/parseBlurayDuration when the main feature can't be
// picked safely: copy-protected discs pad the disc with several titles/playlists
// of (near-)identical length in scrambled order, so "pick the longest" would
// silently grab the wrong one.
export const AMBIGUOUS_FEATURE =
  "Several titles on the disc match the feature's length (typical of copy protection), so the right one " +
  "can't be picked safely. The disc image was not touched; use MakeMKV for this one.";

// The longest DVD title is the main feature. Stops at the first title past the
// end; a title that fails for any other reason (bad headers, probe timeout) is
// skipped. Returns null for a non-DVD image or when no title opens.
// ponytail: same-length decoys within 1 s of the longest are now refused
// (AMBIGUOUS_FEATURE) rather than silently guessed; a decoy more than 1 s off
// is still picked with no way to know it's wrong — verifyRemux's runtime check
// is the last backstop for that case.
export async function findDvdMainTitle(
  probe: (title: number) => Promise<TitleProbe>,
): Promise<{ title: number; seconds: number } | null> {
  const found: { title: number; seconds: number }[] = [];
  let best: { title: number; seconds: number } | null = null;
  for (let title = 1; title <= 99; title++) {
    const result = await probe(title);
    if (result.ok) {
      found.push({ title, seconds: result.seconds });
      if (!best || result.seconds > best.seconds) best = { title, seconds: result.seconds };
      continue;
    }
    const failure = classifyDvdProbeFailure(result.stderr);
    if (failure === 'not-dvd' || failure === 'past-end') break;
  }
  if (!best) return null;
  const main = best;
  if (found.some((t) => t.title !== main.title && Math.abs(t.seconds - main.seconds) < 1)) {
    throw new Error(AMBIGUOUS_FEATURE);
  }
  return main;
}

// libbluray (through ffmpeg's bluray: protocol) logs "playlist 00800.mpls (2:35:12)"
// for each usable playlist, then "selected 00800.mpls" — the longest, which
// ffmpeg picks itself when no -playlist is given (libavformat/bluray.c). A Map
// keyed by playlist number de-dupes a playlist logged more than once, so it's
// never mistaken for a second, distinct playlist of the same length.
export function parseBlurayDuration(log: string): number | null {
  const playlists = new Map<string, number>();
  const re = /playlist (\d+)\.mpls \((\d+):(\d\d):(\d\d)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) {
    playlists.set(m[1], Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]));
  }
  const selected = /selected (\d+)\.mpls/.exec(log)?.[1];
  const seconds = selected ? playlists.get(selected) : undefined;
  if (seconds === undefined) return null;
  const matching = [...playlists.values()].filter((s) => s === seconds).length;
  if (matching > 1) throw new Error(AMBIGUOUS_FEATURE);
  return seconds;
}

// Explains a failed Blu-ray probe/read. libbluray (through ffmpeg's bluray:
// protocol) tags its real error on a "[bluray @ ...]" line (e.g. AACS/BD+
// encryption); the line ffmpeg actually exits on is usually a generic
// "...: I/O error" that names the failure but not the cause.
export function blurayFailureDetail(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);
  let lastTagged: string | null = null;
  for (const line of lines) {
    const m = /\[bluray @ [^\]]*\]\s*(.+)/.exec(line);
    if (m) lastTagged = m[1].trim();
  }
  if (lastTagged) return lastTagged;
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  return nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : null;
}

export type RemuxQuality = 'DVD' | 'Remux-1080p' | 'Remux-2160p';

export function remuxQualityName(kind: DiscKind, height: number | null): RemuxQuality {
  if (kind === 'dvd') return 'DVD';
  return height !== null && height > 1080 ? 'Remux-2160p' : 'Remux-1080p';
}

// Staging folder/file name. It parses (Radarr's QualityParser) to the same
// quality ManualImport is told explicitly, so a manual recovery through
// Radarr's Wanted > Manual Import on the staged folder (e.g. after a crash)
// labels the file the same way. No "-GROUP" suffix on purpose: "DVD-R..."
// would parse as the DVD-R disc quality.
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
// ponytail: the bluray: protocol feeds a bare MPEG-TS, so Blu-ray remuxes carry
// no chapters or track language tags (DVD remuxes keep both); MakeMKV if needed.
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
